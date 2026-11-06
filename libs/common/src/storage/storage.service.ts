import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

interface UploadFileOptions {
  keyPrefix?: string;
  fileName?: string;
  metadata?: Record<string, string>;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client;
  private bucketName: string;

  constructor(private configService: ConfigService) {
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET') || '';

    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID') || '',
        secretAccessKey:
          this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '',
      },
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    options?: UploadFileOptions,
  ): Promise<{ url: string; key: string }> {
    const key = this.buildKey(
      options?.keyPrefix || 'media',
      options?.fileName || file.originalname,
    );

    if (this.bucketName) {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          Metadata: options?.metadata,
        }),
      );

      const url = `https://${this.bucketName}.s3.amazonaws.com/${key}`;
      return { url, key };
    }

    // Fallback: return local file path
    return {
      url: `/uploads/${key}`,
      key,
    };
  }

  async uploadBuffer(
    buffer: Buffer,
    options?: {
      keyPrefix?: string;
      fileName?: string;
      contentType?: string;
      metadata?: Record<string, string>;
    },
  ): Promise<{ url: string; key: string }> {
    const key = this.buildKey(options?.keyPrefix, options?.fileName);

    if (this.bucketName) {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: buffer,
          ContentType: options?.contentType,
          Metadata: options?.metadata,
        }),
      );

      const url = `https://${this.bucketName}.s3.amazonaws.com/${key}`;
      return { url, key };
    }

    return {
      url: `/uploads/${key}`,
      key,
    };
  }

  // Generate a presigned GET URL for a private S3 object. Caller specifies
  // TTL in seconds, clamped to [60, 3600] to limit exposure window.
  async getSignedDownloadUrl(
    s3Key: string,
    expiresInSeconds: number = 900,
  ): Promise<{ url: string; expiresInSeconds: number; expiresAt: string }> {
    if (!this.bucketName) {
      // Local-dev fallback: hand back the deterministic upload path so the
      // FE still gets a usable URL when S3 isn't configured.
      return {
        url: `/uploads/${s3Key}`,
        expiresInSeconds,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    }

    const clamped = Math.min(Math.max(expiresInSeconds, 60), 3600);
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
    });

    const url = await getSignedUrl(this.s3Client, command, {
      expiresIn: clamped,
    });

    return {
      url,
      expiresInSeconds: clamped,
      expiresAt: new Date(Date.now() + clamped * 1000).toISOString(),
    };
  }

  // Hard-delete an S3 object. Idempotent — DeleteObject succeeds even if the
  // key does not exist, so retention cron can call this without pre-checks.
  async deleteObject(s3Key: string): Promise<void> {
    if (!this.bucketName || !s3Key) return;
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: s3Key }),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`DeleteObject failed for ${s3Key}: ${message}`);
    }
  }

  // Fetch the actual size of an S3 object. Returns null if the object can't be
  // found or the bucket isn't configured — callers should treat null as
  // "unknown" rather than failing.
  async getObjectSize(s3Key: string): Promise<number | null> {
    if (!this.bucketName || !s3Key) {
      return null;
    }
    try {
      const result = await this.s3Client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: s3Key }),
      );
      return typeof result.ContentLength === 'number'
        ? result.ContentLength
        : null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`HeadObject failed for ${s3Key}: ${message}`);
      return null;
    }
  }

  private buildKey(prefix = 'uploads', fileName?: string): string {
    const sanitizedName = fileName
      ? fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      : 'artifact.bin';
    const uniqueSuffix = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    return `${this.sanitizeKeyPrefix(prefix)}/${uniqueSuffix}-${sanitizedName}`;
  }

  private sanitizeKeyPrefix(prefix: string): string {
    const cleaned = prefix
      .split('/')
      .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '-'))
      .filter(Boolean)
      .join('/');

    return cleaned || 'uploads';
  }
}
