/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Media, MediaService, MediaType, StorageService } from '@app/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// allowed script file extensions and their corresponding MIME types.
// used by uploadScript to whitelist accepted formats before S3 upload.
const SCRIPT_ALLOWED_EXTENSIONS = [
  'pdf',
  'docx',
  'txt',
  'fdx',
  'fountain',
] as const;
const SCRIPT_ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/xml',
  'text/xml',
  'text/x-fountain',
  'application/octet-stream', // FDX/Fountain files may arrive as octet-stream
]);
const SCRIPT_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — 200-page screenplay with images can exceed 10MB
const SCRIPT_MIN_FILE_SIZE = 50 * 1024; // 50KB — a real screenplay is never smaller than this
const WORK_SAMPLE_ALLOWED_VIDEO_EXTENSIONS = [
  'mp4',
  'mov',
  'm4v',
  'webm',
] as const;
const WORK_SAMPLE_ALLOWED_AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav'] as const;
const WORK_SAMPLE_ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'application/octet-stream',
  'binary/octet-stream',
]);
const WORK_SAMPLE_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const WORK_SAMPLE_KEY_ROOT = 'marketplace/readers';

export interface FileMetadata {
  key: string;
  url: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  uploadedAt: Date;
}

// service responsible for file operations
// follows single responsibility principle - handles only file-related operations
@Injectable()
export class FileServiceService {
  private readonly logger = new Logger(FileServiceService.name);
  private s3Client: S3Client;
  private bucketName: string;

  constructor(
    private readonly storageService: StorageService,
    private readonly mediaService: MediaService,
    private readonly configService: ConfigService,
  ) {
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

  /**
   * Upload a file to S3 and create media record
   * Single Responsibility: Handles file upload and media record creation
   */
  async uploadFile(
    file: Express.Multer.File,
    userId: string,
    folder?: string,
  ): Promise<Media> {
    this.validateFile(file);

    const contentHash = this.computeContentHash(file);

    // Upload file to S3
    const uploadResult = await this.storageService.uploadFile(file, {
      keyPrefix: folder || 'media',
    });

    // Determine media type from file mimetype
    const mediaType = this.determineMediaType(file.mimetype);

    // Create media record in database
    const media = await this.mediaService.createMedia({
      type: mediaType,
      url: uploadResult.url,
      size: file.size,
      userId,
      fileName: file.originalname,
      contentType: file.mimetype,
      s3Key: uploadResult.key,
      contentHash,
    });

    this.logger.log(
      `File uploaded successfully: ${uploadResult.key} by user ${userId}. Media ID: ${media.id}`,
    );

    return media;
  }

  // upload a script file to S3 with script-specific validation.
  // enforces file type whitelist (.pdf, .docx, .txt, .fdx, .fountain), size bounds (50KB–25MB),
  // format-specific structural pre-checks, and a lightweight heuristic for text formats.
  async uploadScript(
    file: Express.Multer.File,
    userId: string,
  ): Promise<Media> {
    this.validateScriptFile(file);

    const contentHash = this.computeContentHash(file);

    // Upload file to S3
    const uploadResult = await this.storageService.uploadFile(file, {
      keyPrefix: 'media/scripts',
      metadata: {
        purpose: 'script_upload',
        ownerUserId: userId,
      },
    });

    // Scripts are always DOCUMENT type
    const media = await this.mediaService.createMedia({
      type: MediaType.DOCUMENT,
      url: uploadResult.url,
      size: file.size,
      userId,
      fileName: file.originalname,
      contentType: file.mimetype,
      s3Key: uploadResult.key,
      contentHash,
    });

    this.logger.log(
      `Script uploaded successfully: ${uploadResult.key} by user ${userId}. Media ID: ${media.id}`,
    );

    return media;
  }

  async uploadReaderWorkSample(
    file: Express.Multer.File,
    userId: string,
  ): Promise<Media> {
    this.validateReaderWorkSampleFile(file);

    const mediaType = this.determineWorkSampleMediaType(file);
    const uploadResult = await this.storageService.uploadFile(file, {
      keyPrefix: `${WORK_SAMPLE_KEY_ROOT}/${userId}/work-samples`,
      metadata: {
        purpose: 'reader_work_sample',
        ownerUserId: userId,
        mediaType,
      },
    });

    const contentHash = this.computeContentHash(file);

    const media = await this.mediaService.createMedia({
      type: mediaType,
      url: uploadResult.url,
      size: file.size,
      userId,
      fileName: file.originalname,
      contentType: file.mimetype,
      s3Key: uploadResult.key,
      contentHash,
    });

    this.logger.log(
      `Reader work sample uploaded successfully: ${uploadResult.key} by user ${userId}. Media ID: ${media.id}`,
    );

    return media;
  }

  // validate a file intended to be a script.
  // checks: file type whitelist (extension + MIME), size bounds (50KB min, 25MB max),
  // format-specific pre-checks (FDX XML validity, PDF header), and a lightweight
  // heuristic for text-extractable formats.
  private validateScriptFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (file.size === 0) {
      throw new BadRequestException('File cannot be empty');
    }

    // enforce minimum size — real screenplays are never under 50KB
    if (file.size < SCRIPT_MIN_FILE_SIZE) {
      throw new BadRequestException(
        'This file is too small to be a screenplay (minimum 50KB). A real screenplay is at least a few pages long.',
      );
    }

    // enforce 25MB limit for scripts
    if (file.size > SCRIPT_MAX_FILE_SIZE) {
      throw new BadRequestException(
        `Script file size exceeds the 25MB limit. If your PDF contains many embedded images, try exporting a text-only version.`,
      );
    }

    // validate file extension
    const extension = file.originalname?.toLowerCase().split('.').pop() || '';
    if (
      !SCRIPT_ALLOWED_EXTENSIONS.includes(
        extension as (typeof SCRIPT_ALLOWED_EXTENSIONS)[number],
      )
    ) {
      throw new BadRequestException(
        `Unsupported file type ".${extension}". Accepted formats: ${SCRIPT_ALLOWED_EXTENSIONS.join(', ')}.`,
      );
    }

    // validate MIME type (prevents renamed files)
    if (!SCRIPT_ALLOWED_MIME_TYPES.has(file.mimetype)) {
      // allow if extension is whitelisted but MIME is generic (browsers may send generic types)
      const isGenericMime =
        file.mimetype === 'application/octet-stream' ||
        file.mimetype === 'binary/octet-stream';
      if (!isGenericMime) {
        throw new BadRequestException(
          `File MIME type "${file.mimetype}" does not match expected types for .${extension} files.`,
        );
      }
    }

    // format-specific pre-checks before S3 upload
    if (extension === 'fdx') {
      this.validateFdxStructure(file.buffer);
      return;
    }

    if (extension === 'pdf') {
      this.validatePdfHeader(file.buffer);
      return; // full layout parsing happens in the Python service
    }

    if (extension === 'docx') {
      this.validateDocxStructure(file.buffer);
      return;
    }

    // lightweight heuristic for .txt and .fountain files — check if content looks like a screenplay
    if ((extension === 'txt' || extension === 'fountain') && file.buffer) {
      this.runScriptHeuristic(file.buffer.toString('utf-8'));
    }
  }

  private validateReaderWorkSampleFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (file.size === 0) {
      throw new BadRequestException('File cannot be empty');
    }

    if (file.size > WORK_SAMPLE_MAX_FILE_SIZE) {
      throw new BadRequestException(
        `Work sample file size exceeds the ${WORK_SAMPLE_MAX_FILE_SIZE / (1024 * 1024)}MB limit.`,
      );
    }

    const extension = this.getFileExtension(file.originalname);
    const isAllowedExtension =
      this.isVideoWorkSampleExtension(extension) ||
      this.isAudioWorkSampleExtension(extension);

    if (!isAllowedExtension) {
      throw new BadRequestException(
        `Unsupported work sample file type ".${extension}". Accepted formats: ${[
          ...WORK_SAMPLE_ALLOWED_VIDEO_EXTENSIONS,
          ...WORK_SAMPLE_ALLOWED_AUDIO_EXTENSIONS,
        ].join(', ')}.`,
      );
    }

    if (!WORK_SAMPLE_ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `File MIME type "${file.mimetype}" is not supported for reader work samples.`,
      );
    }

    const mediaType = this.determineWorkSampleMediaType(file);
    const mimeLooksLikeVideo = file.mimetype.startsWith('video/');
    const mimeLooksLikeAudio = file.mimetype.startsWith('audio/');
    const isGenericMime =
      file.mimetype === 'application/octet-stream' ||
      file.mimetype === 'binary/octet-stream';

    if (
      !isGenericMime &&
      ((mediaType === MediaType.VIDEO && !mimeLooksLikeVideo) ||
        (mediaType === MediaType.AUDIO && !mimeLooksLikeAudio))
    ) {
      throw new BadRequestException(
        `File MIME type "${file.mimetype}" does not match the .${extension} work sample format.`,
      );
    }
  }

  // verify FDX file contains valid XML by checking for required structural markers.
  // a valid FDX file must begin with an XML declaration or a <FinalDraft root element.
  // rejects corrupted or misnamed files before wasting S3 bandwidth on them.
  private validateFdxStructure(buffer: Buffer): void {
    if (!buffer || buffer.length < 5) {
      throw new BadRequestException(
        'This .fdx file appears to be empty or corrupt.',
      );
    }

    // strip UTF-8 BOM if present (0xEF 0xBB 0xBF)
    let offset = 0;
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      offset = 3;
    }

    const header = buffer.slice(offset, offset + 200).toString('utf-8');
    const trimmed = header.trimStart();

    const hasXmlDeclaration = trimmed.startsWith('<?xml');
    const hasFinalDraftRoot = trimmed.includes('<FinalDraft');

    if (!hasXmlDeclaration && !hasFinalDraftRoot) {
      throw new BadRequestException(
        'This .fdx file is not valid Final Draft XML. The file may be corrupted or renamed from a different format.',
      );
    }
  }

  // verify PDF file begins with the required %PDF- header.
  // any file missing this 5-byte signature is not a PDF regardless of extension.
  private validatePdfHeader(buffer: Buffer): void {
    if (!buffer || buffer.length < 5) {
      throw new BadRequestException(
        'This PDF file appears to be empty or corrupt.',
      );
    }

    const header = buffer.slice(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      throw new BadRequestException(
        'This file does not appear to be a valid PDF. The file may be corrupted or renamed from a different format.',
      );
    }
  }

  // verify DOCX file begins with the ZIP magic bytes PK\x03\x04.
  // DOCX (Office Open XML) is a ZIP archive — any file missing this 4-byte
  // signature is not a valid DOCX regardless of extension.
  private validateDocxStructure(buffer: Buffer): void {
    if (!buffer || buffer.length < 4) {
      throw new BadRequestException(
        'This .docx file appears to be empty or corrupt.',
      );
    }

    // ZIP magic: 0x50 0x4B 0x03 0x04
    if (
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b ||
      buffer[2] !== 0x03 ||
      buffer[3] !== 0x04
    ) {
      throw new BadRequestException(
        'This file does not appear to be a valid Word document. The file may be corrupted or renamed from a different format.',
      );
    }
  }

  // lightweight heuristic check to catch obvious non-scripts.
  // reads the first ~3 pages worth of text and checks for screenplay indicators.
  // not meant to be perfect — the full AI validation in ai_service catches edge cases.
  private runScriptHeuristic(content: string): void {
    // take first ~6000 characters (~2-3 pages)
    const sample = content.substring(0, 6000).toUpperCase();

    const indicators = [
      /\b(INT\.|EXT\.|INT\/EXT\.)/,
      /\bFADE\s+(IN|OUT)/,
      /\b(CUT\s+TO|DISSOLVE\s+TO)/,
      /\b(CONT'D|V\.O\.|O\.S\.)/,
      /^[A-Z][A-Z\s]{2,}$/m, // Character name line (all caps)
    ];

    const matchCount = indicators.filter((p) => p.test(sample)).length;

    // also check for dialogue-like patterns: caps line followed by regular text
    const lines = content
      .substring(0, 6000)
      .split('\n')
      .filter((l) => l.trim());
    let dialoguePatterns = 0;
    for (let i = 0; i < Math.min(lines.length - 1, 40); i++) {
      const line = lines[i].trim();
      const nextLine = lines[i + 1]?.trim() || '';
      if (
        /^[A-Z][A-Z\s]{1,30}$/.test(line) &&
        nextLine.length > 5 &&
        !/^(INT\.|EXT\.|FADE|CUT)/i.test(nextLine)
      ) {
        dialoguePatterns++;
      }
    }

    // reject only if there are zero screenplay indicators at all
    if (matchCount === 0 && dialoguePatterns < 2) {
      throw new BadRequestException(
        'This file does not appear to be a screenplay or script. ' +
          'Expected scene headings (INT./EXT.), character names, or dialogue formatting. ' +
          'If this is a valid script, try uploading as PDF instead.',
      );
    }
  }

  /**
   * Determine media type from MIME type
   * Single Responsibility: Only maps MIME types to MediaType enum
   */
  private determineMediaType(mimeType: string): MediaType {
    if (mimeType.startsWith('image/')) {
      return MediaType.IMAGE;
    }
    if (mimeType.startsWith('video/')) {
      return MediaType.VIDEO;
    }
    if (mimeType.startsWith('audio/')) {
      return MediaType.AUDIO;
    }
    // Default to DOCUMENT for PDFs, text files, etc.
    return MediaType.DOCUMENT;
  }

  private determineWorkSampleMediaType(file: Express.Multer.File): MediaType {
    const extension = this.getFileExtension(file.originalname);

    if (this.isVideoWorkSampleExtension(extension)) {
      return MediaType.VIDEO;
    }

    if (this.isAudioWorkSampleExtension(extension)) {
      return MediaType.AUDIO;
    }

    throw new BadRequestException(
      `Unsupported work sample file type ".${extension}".`,
    );
  }

  private getFileExtension(fileName: string): string {
    return fileName?.toLowerCase().split('.').pop() || '';
  }

  private isVideoWorkSampleExtension(extension: string): boolean {
    return WORK_SAMPLE_ALLOWED_VIDEO_EXTENSIONS.includes(
      extension as (typeof WORK_SAMPLE_ALLOWED_VIDEO_EXTENSIONS)[number],
    );
  }

  private isAudioWorkSampleExtension(extension: string): boolean {
    return WORK_SAMPLE_ALLOWED_AUDIO_EXTENSIONS.includes(
      extension as (typeof WORK_SAMPLE_ALLOWED_AUDIO_EXTENSIONS)[number],
    );
  }

  /**
   * Get file metadata from S3
   * Single Responsibility: Only retrieves file metadata
   */
  async getFileMetadata(key: string): Promise<FileMetadata> {
    if (!this.bucketName) {
      throw new BadRequestException('S3 bucket is not configured');
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      return {
        key,
        url: `https://${this.bucketName}.s3.amazonaws.com/${key}`,
        fileName: key.split('/').pop() || key,
        fileSize: response.ContentLength || 0,
        contentType: response.ContentType || 'application/octet-stream',
        uploadedAt: response.LastModified || new Date(),
      };
    } catch (error: any) {
      if (
        error.name === 'NotFound' ||
        error.$metadata?.httpStatusCode === 404
      ) {
        throw new NotFoundException(`File with key ${key} not found`);
      }
      this.logger.error(
        `Error getting file metadata: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException('Failed to retrieve file metadata');
    }
  }

  /**
   * Download file from S3
   * Single Responsibility: Only handles file download
   */
  async downloadFile(key: string): Promise<{
    stream: Readable;
    metadata: FileMetadata;
  }> {
    if (!this.bucketName) {
      throw new BadRequestException('S3 bucket is not configured');
    }

    try {
      const metadata = await this.getFileMetadata(key);

      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new NotFoundException(`File with key ${key} not found`);
      }

      const stream = response.Body as Readable;

      this.logger.log(`File downloaded: ${key}`);

      return { stream, metadata };
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(
        `Error downloading file: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException('Failed to download file');
    }
  }

  /**
   * Stream file from S3
   * Single Responsibility: Only handles file streaming
   */
  async streamFile(
    key: string,
    start?: number,
    end?: number,
  ): Promise<{
    stream: Readable;
    metadata: FileMetadata;
    contentRange?: string;
  }> {
    if (!this.bucketName) {
      throw new BadRequestException('S3 bucket is not configured');
    }

    try {
      const metadata = await this.getFileMetadata(key);

      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Range:
          start !== undefined && end !== undefined
            ? `bytes=${start}-${end}`
            : undefined,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new NotFoundException(`File with key ${key} not found`);
      }

      const stream = response.Body as Readable;
      const contentRange = response.ContentRange;

      this.logger.log(
        `File streamed: ${key}${contentRange ? ` (${contentRange})` : ''}`,
      );

      return { stream, metadata, contentRange };
    } catch (error: any) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Error streaming file: ${error.message}`, error.stack);
      throw new BadRequestException('Failed to stream file');
    }
  }

  // generate a presigned GET URL for a private S3 object.
  // expiry is capped at 3600s to limit exposure window.
  async getPresignedUrl(
    key: string,
    expiresIn = 1800,
  ): Promise<{ url: string; expiresIn: number; expiresAt: string }> {
    if (!this.bucketName) {
      throw new BadRequestException('S3 bucket is not configured');
    }

    const clampedExpiry = Math.min(Math.max(expiresIn, 60), 3600);

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    try {
      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: clampedExpiry,
      });

      const expiresAt = new Date(
        Date.now() + clampedExpiry * 1000,
      ).toISOString();

      this.logger.log(
        `Presigned URL generated for key: ${key} (${clampedExpiry}s)`,
      );

      return { url, expiresIn: clampedExpiry, expiresAt };
    } catch (error: any) {
      this.logger.error(
        `Error generating presigned URL for ${key}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException('Failed to generate presigned URL');
    }
  }

  /**
   * Delete file from S3 and media record
   * Single Responsibility: Handles file deletion from S3 and database
   */
  async deleteFile(key: string): Promise<void> {
    if (!this.bucketName) {
      throw new BadRequestException('S3 bucket is not configured');
    }

    try {
      // Find media record by S3 key
      const media = await this.mediaService.findByS3Key(key);

      // Delete from S3
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      await this.s3Client.send(command);

      // Delete media record if it exists
      if (media) {
        await this.mediaService.deleteMedia(media.id);
        this.logger.log(
          `File and media record deleted: ${key} (Media ID: ${media.id})`,
        );
      } else {
        this.logger.log(`File deleted from S3 (no media record found): ${key}`);
      }
    } catch (error: any) {
      this.logger.error(`Error deleting file: ${error.message}`, error.stack);
      throw new BadRequestException('Failed to delete file');
    }
  }

  // Compute SHA-256 over the uploaded bytes. Used downstream as a content-
  // addressed cache key so analysis results can be reused across sessions.
  // Multer holds the full buffer in memory already (file_service does not
  // stream uploads), so a sync hash is correct here; switch to a transform
  // stream if upload caps grow large enough to risk OOM.
  private computeContentHash(file: Express.Multer.File): string {
    return createHash('sha256').update(file.buffer).digest('hex');
  }

  /**
   * Validate uploaded file
   * Single Responsibility: Only validates file properties
   */
  private validateFile(file: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const maxFileSize = 50 * 1024 * 1024; // 50MB
    if (file.size > maxFileSize) {
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${maxFileSize / (1024 * 1024)}MB`,
      );
    }

    if (file.size === 0) {
      throw new BadRequestException('File cannot be empty');
    }
  }
}
