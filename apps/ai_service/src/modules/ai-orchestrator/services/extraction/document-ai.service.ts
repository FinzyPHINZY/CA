import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'node:fs/promises';
import {
  DocumentExtractor,
  DocumentExtractionResult,
} from './document-extraction.types';
import { ExtractedBlock } from './document-extraction.types';
import { StorageService } from '@app/common';

@Injectable()
export class DocumentAiExtractService implements DocumentExtractor {
  private readonly logger = new Logger(DocumentAiExtractService.name);
  private readonly projectId?: string;
  private readonly location?: string;
  private readonly processorId?: string;
  private readonly credentialsPath?: string;
  private auth?: GoogleAuth;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly storageService: StorageService,
  ) {
    this.projectId = this.configService.get<string>('GOOGLE_DOC_AI_PROJECT_ID');
    this.location = this.configService.get<string>('GOOGLE_DOC_AI_LOCATION');
    this.processorId = this.configService.get<string>(
      'GOOGLE_DOC_AI_PROCESSOR_ID',
    );
    this.credentialsPath = this.configService.get<string>(
      'GOOGLE_APPLICATION_CREDENTIALS',
    );
  }

  get isConfigured(): boolean {
    return Boolean(
      this.projectId &&
        this.location &&
        this.processorId &&
        this.credentialsPath,
    );
  }

  canHandle(extension: string): boolean {
    return this.isConfigured && extension.toLowerCase() === 'pdf';
  }

  async extract(
    buffer: Buffer,
    fileName: string,
  ): Promise<DocumentExtractionResult> {
    if (!this.isConfigured) {
      throw new Error('Google Document AI credentials are not configured.');
    }

    const endpoint = this.buildProcessEndpoint();
    this.logger.log(
      `[Document AI] Processing ${fileName} via processor ${this.processorId} in ${this.location}`,
    );

    const token = await this.getAccessToken();
    const encodedDocument = buffer.toString('base64');

    let response: any;
    try {
      response = await firstValueFrom(
        this.httpService.post(
          endpoint,
          {
            rawDocument: {
              content: encodedDocument,
              mimeType: 'application/pdf',
            },
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            timeout: 120000,
          },
        ),
      );
    } catch (error: any) {
      const status = error?.response?.status;
      const message =
        error?.response?.data?.error?.message ||
        error?.message ||
        'Unknown Document AI error';
      this.logger.error(
        `[Document AI] Request failed ${status || ''}: ${message}`,
      );
      throw new Error(`Google Document AI extraction failed: ${message}`);
    }

    const document = response?.data?.document;
    if (!document) {
      this.logger.warn('[Document AI] No document payload returned.');
      return {
        source: 'google_document_ai',
        warnings: ['Document AI did not return a document payload.'],
        blocks: [],
        metadata: {
          fileName,
          processorId: this.processorId,
          location: this.location,
        },
      };
    }

    const artifactInfo = await this.persistDocumentArtifact(fileName, document);
    const blocks = this.mapDocumentToBlocks(document);
    this.logger.log(
      `[Document AI] Parsed ${blocks.length} blocks from ${fileName}`,
    );

    const warnings = Array.isArray(response?.data?.warnings)
      ? response.data.warnings
      : undefined;

    return {
      source: 'google_document_ai',
      warnings,
      blocks,
      metadata: {
        fileName,
        processorId: this.processorId,
        projectId: this.projectId,
        location: this.location,
        documentName: response?.data?.document?.uri ?? response?.data?.name,
        humanReviewOperation: response?.data?.humanReviewOperation,
        artifactStorage: artifactInfo ?? undefined,
      },
    };
  }

  private buildProcessEndpoint(): string {
    return `https://documentai.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/processors/${this.processorId}:process`;
  }

  private async getAccessToken(): Promise<string> {
    this.logger.log(
      `[Document AI] Using credentials file: ${this.credentialsPath}`,
    );
    try {
      await fs.access(this.credentialsPath!);
    } catch (error: any) {
      throw new Error(
        `Document AI credentials file is not accessible at ${this.credentialsPath}: ${error.message}`,
      );
    }

    if (!this.auth) {
      this.auth = new GoogleAuth({
        keyFile: this.credentialsPath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    }

    const accessToken = await this.auth.getAccessToken();
    if (!accessToken) {
      throw new Error('Unable to obtain Google Document AI access token.');
    }
    return accessToken;
  }

  private mapDocumentToBlocks(document: any): ExtractedBlock[] {
    const documentText =
      typeof document?.text === 'string' ? document.text : '';
    const pages = Array.isArray(document?.pages) ? document.pages : [];
    const blocks: ExtractedBlock[] = [];

    pages.forEach((page: any, index: number) => {
      const pageNumber =
        typeof page?.pageNumber === 'number' && page.pageNumber > 0
          ? page.pageNumber
          : index + 1;
      const dimension = this.normalizeDimension(page?.dimension);
      const segments = this.extractSegments(page);
      for (const segment of segments) {
        const layout = segment.layout;
        const text = this.resolveText(documentText, layout?.textAnchor);
        const normalizedText = text?.replace(/\s+/g, ' ').trim();
        if (!normalizedText) continue;

        const boundingBox = this.mapBoundingBox(layout, dimension);
        const attributes: Record<string, any> = {};
        if (layout?.confidence !== undefined) {
          attributes.confidence = layout.confidence;
        }
        if (
          Array.isArray(layout?.detectedLanguages) &&
          layout.detectedLanguages.length > 0
        ) {
          attributes.languages = layout.detectedLanguages
            .map((lang: any) => lang.languageCode)
            .filter(Boolean);
        }
        attributes.segmentType = segment.segmentType;
        if (segment.raw?.type) {
          attributes.blockType = segment.raw.type;
        }

        blocks.push({
          text: normalizedText,
          page: pageNumber,
          boundingBox,
          attributes: Object.keys(attributes).length ? attributes : undefined,
        });
      }
    });

    return blocks;
  }

  private extractSegments(page: any): Array<{
    layout: any;
    segmentType: string;
    raw: any;
  }> {
    const priorities = [
      { key: 'lines', segmentType: 'line' },
      { key: 'paragraphs', segmentType: 'paragraph' },
      { key: 'blocks', segmentType: 'block' },
    ];

    for (const priority of priorities) {
      const items = Array.isArray(page?.[priority.key])
        ? page[priority.key]
        : [];
      if (items.length) {
        return items.map((item: any) => ({
          layout: item?.layout ?? item,
          segmentType: priority.segmentType,
          raw: item,
        }));
      }
    }

    const tokens = Array.isArray(page?.tokens) ? page.tokens : [];
    return tokens.map((token: any) => ({
      layout: token?.layout ?? token,
      segmentType: 'token',
      raw: token,
    }));
  }

  private resolveText(
    documentText: string,
    textAnchor?: {
      content?: string;
      textSegments?: Array<{
        startIndex?: string | number;
        endIndex?: string | number;
      }>;
    },
  ): string {
    if (!textAnchor) return '';
    if (typeof textAnchor.content === 'string') {
      return textAnchor.content;
    }

    const segments = Array.isArray(textAnchor.textSegments)
      ? textAnchor.textSegments
      : [];
    if (!segments.length || !documentText) {
      return '';
    }

    let output = '';
    for (const segment of segments) {
      const start =
        segment.startIndex !== undefined ? Number(segment.startIndex) : 0;
      const end =
        segment.endIndex !== undefined
          ? Number(segment.endIndex)
          : documentText.length;
      output += documentText.slice(start, end);
    }
    return output;
  }

  private normalizeDimension(dimension?: {
    width?: number;
    height?: number;
    unit?: string;
  }): { width: number; height: number } {
    const defaultWidth = 8.5;
    const defaultHeight = 11;
    if (!dimension) {
      return { width: defaultWidth * 72, height: defaultHeight * 72 };
    }

    const width =
      typeof dimension.width === 'number' ? dimension.width : defaultWidth;
    const height =
      typeof dimension.height === 'number' ? dimension.height : defaultHeight;
    const multiplier = this.unitToPoints(
      typeof dimension.unit === 'string' ? dimension.unit : 'INCH',
    );

    return { width: width * multiplier, height: height * multiplier };
  }

  private unitToPoints(unit: string): number {
    const normalized = unit.toLowerCase();
    switch (normalized) {
      case 'inch':
      case 'inches':
      case 'in':
        return 72;
      case 'centimeter':
      case 'centimeters':
      case 'cm':
        return 72 / 2.54;
      case 'millimeter':
      case 'millimeters':
      case 'mm':
        return 72 / 25.4;
      case 'point':
      case 'points':
      case 'pt':
      case 'pts':
        return 1;
      case 'pixel':
      case 'pixels':
      case 'px':
        return 1;
      default:
        return 72;
    }
  }

  private mapBoundingBox(
    layout: any,
    dimension: { width: number; height: number },
  ): number[] | undefined {
    const poly = layout?.boundingPoly;
    if (!poly) return undefined;
    const vertices = this.resolveVertices(poly, dimension);
    if (!vertices.length) return undefined;
    return vertices.flatMap((vertex) => [vertex.x, vertex.y]);
  }

  private resolveVertices(
    boundingPoly: any,
    dimension: { width: number; height: number },
  ): Array<{ x: number; y: number }> {
    const normalizedVertices = Array.isArray(boundingPoly?.normalizedVertices)
      ? boundingPoly.normalizedVertices
      : [];
    if (normalizedVertices.length) {
      return normalizedVertices.map((vertex: any) => ({
        x: (typeof vertex?.x === 'number' ? vertex.x : 0) * dimension.width,
        y: (typeof vertex?.y === 'number' ? vertex.y : 0) * dimension.height,
      }));
    }

    const vertices = Array.isArray(boundingPoly?.vertices)
      ? boundingPoly.vertices
      : [];
    return vertices.map((vertex: any) => ({
      x: typeof vertex?.x === 'number' ? vertex.x : 0,
      y: typeof vertex?.y === 'number' ? vertex.y : 0,
    }));
  }

  private async persistDocumentArtifact(
    fileName: string,
    document: any,
  ): Promise<{ key: string; url: string } | null> {
    try {
      const payload = JSON.stringify(document);
      const buffer = Buffer.from(payload);
      return await this.storageService.uploadBuffer(buffer, {
        keyPrefix: 'script-extractions/document-ai',
        fileName: `${fileName.replace(/\.[^.]+$/, '') || 'document'}.json`,
        contentType: 'application/json',
        metadata: {
          extractor: 'google_document_ai',
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `[Document AI] Failed to persist artifact for ${fileName}: ${error.message}`,
      );
      return null;
    }
  }
}
