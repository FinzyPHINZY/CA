import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import axios from 'axios';
import { firstValueFrom } from 'rxjs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { promisify } from 'node:util';
import { execFile as callbackExecFile } from 'node:child_process';
import {
  DocumentExtractor,
  DocumentExtractionResult,
  ExtractedBlock,
} from './document-extraction.types';
import { StorageService } from '@app/common';

const execFile = promisify(callbackExecFile);

@Injectable()
export class AdobeExtractService implements DocumentExtractor {
  private readonly logger = new Logger(AdobeExtractService.name);
  private readonly baseUrl: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly scopes: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly storageService: StorageService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'ADOBE_PDF_BASE_URL',
      'https://pdf-services.adobe.io',
    );
    this.clientId = this.configService.get<string>('ADOBE_PDF_CLIENT_ID');
    this.clientSecret = this.configService.get<string>(
      'ADOBE_PDF_CLIENT_SECRET',
    );
    this.scopes = this.configService.get<string>(
      'ADOBE_PDF_SCOPES',
      'openid,AdobeID,DCAPI',
    );
  }

  get isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  canHandle(extension: string): boolean {
    return this.isConfigured && extension.toLowerCase() === 'pdf';
  }

  async extract(
    buffer: Buffer,
    fileName: string,
  ): Promise<DocumentExtractionResult> {
    if (!this.isConfigured) {
      throw new Error('Adobe PDF Services credentials are not configured.');
    }

    const token = await this.getAccessToken();
    const jobId = await this.submitJob(buffer, fileName, token);
    const result = await this.pollJob(jobId, token);
    const { blocks, artifactStorage } =
      await this.downloadAndNormalizeArtifacts(result, token, fileName, jobId);

    return {
      source: 'adobe_pdf_extract',
      jobId,
      warnings: result.warnings ?? [],
      errors: result.errors ?? [],
      blocks,
      metadata: {
        fileName,
        assetDownloadLinks: result.links,
        artifactStorage,
      },
    };
  }

  private async getAccessToken(): Promise<string> {
    const params = new URLSearchParams();
    params.append('client_id', this.clientId!);
    params.append('client_secret', this.clientSecret!);
    params.append('grant_type', 'client_credentials');
    params.append('scope', this.scopes);

    let response: any;
    try {
      response = await firstValueFrom(
        this.httpService.post(
          'https://ims-na1.adobelogin.com/ims/token/v3',
          params,
        ),
      );
    } catch (error: any) {
      this.logAdobeHttpError('Token request failed', error);
      throw error;
    }

    return response.data.access_token;
  }

  private async submitJob(
    buffer: Buffer,
    fileName: string,
    token: string,
  ): Promise<string> {
    let response: any;
    try {
      response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/operation/extractpdf`, buffer, {
          headers: {
            'Content-Type': 'application/pdf',
            'x-api-key': this.clientId,
            Authorization: `Bearer ${token}`,
            'Accept-Language': 'en-US',
            'Content-Disposition': `attachment; filename="${fileName}"`,
          },
        }),
      );
    } catch (error: any) {
      this.logAdobeHttpError(
        `Submit job failed for ${fileName}`,
        error,
        fileName,
      );
      throw error;
    }

    const location = response.headers['location'];
    if (!location) {
      throw new Error('Adobe PDF Extract did not return a job location.');
    }

    const jobId = location.split('/').pop();
    if (!jobId) {
      throw new Error('Unable to parse Adobe job ID from location header.');
    }

    return jobId;
  }

  private async pollJob(jobId: string, token: string): Promise<any> {
    const statusUrl = `${this.baseUrl}/operation/extractpdf/${jobId}`;

    for (let attempt = 0; attempt < 24; attempt += 1) {
      let response: any;
      try {
        response = await firstValueFrom(
          this.httpService.get(statusUrl, {
            headers: {
              'x-api-key': this.clientId,
              Authorization: `Bearer ${token}`,
            },
          }),
        );
      } catch (error: any) {
        this.logAdobeHttpError(
          `Polling failed for job ${jobId} (attempt ${attempt + 1})`,
          error,
        );
        throw error;
      }

      if (response.data.status === 'done') {
        return response.data;
      }

      if (response.data.status === 'failed') {
        throw new Error(
          `Adobe PDF Extract job failed: ${JSON.stringify(response.data)}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(
      `Adobe PDF Extract job ${jobId} did not complete within the allotted time.`,
    );
  }

  private async downloadAndNormalizeArtifacts(
    result: any,
    token: string,
    fileName: string,
    jobId: string,
  ): Promise<{
    blocks: DocumentExtractionResult['blocks'];
    artifactStorage?: { key: string; url: string };
  }> {
    const contentLink = result?.links?.output?.find(
      (link: any) => link.rel === 'content',
    );
    if (!contentLink?.href) {
      this.logger.warn('No content artifact returned by Adobe.');
      return { blocks: [], artifactStorage: undefined };
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adobe-extract-'));
    const zipPath = path.join(tempDir, `${crypto.randomUUID()}-extract.zip`);
    const zipStream = await firstValueFrom(
      this.httpService.get(contentLink.href, {
        headers: {
          'x-api-key': this.clientId,
          Authorization: `Bearer ${token}`,
        },
        responseType: 'arraybuffer',
      }),
    );
    await fs.writeFile(zipPath, zipStream.data);
    const artifactStorage = await this.persistArtifact(
      zipPath,
      fileName,
      jobId,
    );

    try {
      await execFile('unzip', ['-o', zipPath, '-d', tempDir]);
    } catch (unzipError: any) {
      this.logger.error(
        `Failed to unzip Adobe artifact: ${unzipError.message}`,
      );
      throw unzipError;
    }

    const structuredPath = path.join(tempDir, 'structuredData.json');
    let structuredJson: any = null;
    try {
      const raw = await fs.readFile(structuredPath, 'utf-8');
      structuredJson = JSON.parse(raw);
    } catch (readError: any) {
      this.logger.warn(
        `Adobe Extract structuredData.json missing or invalid: ${readError.message}`,
      );
    }

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => null);

    if (!structuredJson) {
      return { blocks: [], artifactStorage: artifactStorage ?? undefined };
    }

    return {
      blocks: this.mapStructuredData(structuredJson),
      artifactStorage: artifactStorage ?? undefined,
    };
  }

  private mapStructuredData(structured: any): ExtractedBlock[] {
    const elements = Array.isArray(structured?.elements)
      ? structured.elements
      : [];

    const blocks: ExtractedBlock[] = [];

    for (const element of elements) {
      const text = typeof element?.Text === 'string' ? element.Text.trim() : '';
      if (!text) continue;
      blocks.push({
        text,
        page:
          typeof element?.Page === 'number' && element.Page > 0
            ? element.Page
            : 1,
        boundingBox: Array.isArray(element?.Bounds)
          ? element.Bounds
          : undefined,
        attributes: {
          path: element?.Path,
          type: element?.TextType,
          font: element?.TextAttributes?.Font?.Name,
          fontSize: element?.TextAttributes?.Font?.Size,
        },
      });
    }

    return blocks;
  }

  private async persistArtifact(
    artifactPath: string,
    fileName: string,
    jobId: string,
  ): Promise<{ key: string; url: string } | null> {
    try {
      const buffer = await fs.readFile(artifactPath);
      return await this.storageService.uploadBuffer(buffer, {
        keyPrefix: 'script-extractions/adobe',
        fileName: `${path.basename(fileName, path.extname(fileName)) || 'script'}-${jobId}.zip`,
        contentType: 'application/zip',
        metadata: {
          extractor: 'adobe_pdf_extract',
          jobId,
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `[Adobe Extract] Failed to upload artifact for job ${jobId}: ${error.message}`,
      );
      return null;
    }
  }

  private logAdobeHttpError(
    context: string,
    error: any,
    fileName?: string,
  ): void {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 'unknown';
      const responseData =
        typeof error.response?.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response?.data ?? {});
      this.logger.error(
        `[Adobe Extract] ${context}. status=${status}${fileName ? ` file=${fileName}` : ''} response=${responseData}`,
      );
      return;
    }

    this.logger.error(
      `[Adobe Extract] ${context}. ${error?.message || String(error)}`,
    );
  }
}
