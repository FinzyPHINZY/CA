/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { JwtAuthGuard, Media } from '@app/common';
import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import {
  BadRequestErrorResponseDto,
  NotFoundErrorResponseDto,
  UnauthorizedErrorResponseDto,
} from './dto/error-response.dto';
import { FileMetadataResponseDto } from './dto/file-metadata-response.dto';
import { MediaResponseDto } from './dto/media-response.dto';
import { FileServiceService } from './file_service.service';

@ApiTags('Files')
@Controller('files')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class FileServiceController {
  constructor(private readonly fileService: FileServiceService) {}

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a file',
    description:
      'Uploads a generic file to S3 storage. The file will be stored with a unique key and URL will be returned. Maximum file size is 50MB. ' +
      'Do not use this endpoint for screenplay uploads or reader work sample uploads; use the dedicated endpoints instead.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File upload with optional folder',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'File to upload (max 50MB)',
        },
        folder: {
          type: 'string',
          description:
            'Optional folder path to organize files (e.g., "documents", "images/videos")',
          example: 'documents',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'File uploaded successfully and media record created',
    type: MediaResponseDto,
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        type: {
          type: 'string',
          enum: ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'],
          example: 'DOCUMENT',
        },
        url: {
          type: 'string',
          example:
            'https://bucket.s3.amazonaws.com/documents/1704067200000-document.pdf',
        },
        size: {
          type: 'number',
          example: 1024000,
        },
        userId: {
          type: 'string',
          example: 'user-123',
        },
        fileName: {
          type: 'string',
          nullable: true,
          example: 'document.pdf',
        },
        contentType: {
          type: 'string',
          nullable: true,
          example: 'application/pdf',
        },
        s3Key: {
          type: 'string',
          nullable: true,
          example: 'documents/1704067200000-document.pdf',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00Z',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00Z',
        },
        deletedAt: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          example: null,
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid file or missing required fields. Common errors: file is required, file size exceeds maximum allowed size of 50MB, invalid file type, or S3 bucket is not configured.',
    type: BadRequestErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 400,
        },
        message: {
          oneOf: [
            {
              type: 'string',
              example: 'File is required',
            },
            {
              type: 'array',
              items: { type: 'string' },
              example: [
                'File is required',
                'File size exceeds maximum allowed size of 50MB',
              ],
            },
          ],
        },
        error: {
          type: 'string',
          example: 'Bad Request',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 401,
        },
        message: {
          type: 'string',
          example: 'Invalid or missing authentication token',
        },
        error: {
          type: 'string',
          example: 'Unauthorized',
        },
      },
    },
  })
  async uploadFile(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder?: string,
  ): Promise<Media> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error(
        'User ID not found in request. Ensure JWT authentication is properly configured.',
      );
    }
    return this.fileService.uploadFile(file, userId, folder);
  }

  @Post('upload/script')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a script file',
    description:
      'Uploads a screenplay/script file with strict validation. ' +
      'Accepted formats: .pdf, .docx, .txt, .fdx (Final Draft). Max size: 10MB. ' +
      'Text files are checked for screenplay formatting before upload.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Script file upload',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Script file to upload (.pdf, .docx, .txt, .fdx — max 10MB)',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Script uploaded successfully and media record created',
    type: MediaResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid script file. Common errors: unsupported file type, file too large (>10MB), or content does not appear to be a screenplay.',
    type: BadRequestErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
  })
  async uploadScript(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<Media> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error(
        'User ID not found in request. Ensure JWT authentication is properly configured.',
      );
    }
    return this.fileService.uploadScript(file, userId);
  }

  @Post('upload/reader-work-sample')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a reader work sample file',
    description:
      'Uploads a reader work sample with work-sample-specific validation. ' +
      'Accepted formats: .mp4, .mov, .m4v, .webm, .mp3, .m4a, .wav. ' +
      'Max size: 100MB. Files are stored under a structured marketplace reader work-samples S3 path.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Reader work sample upload',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Work sample file to upload (.mp4, .mov, .m4v, .webm, .mp3, .m4a, .wav — max 100MB)',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description:
      'Reader work sample uploaded successfully and media record created',
    type: MediaResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid work sample file. Common errors: unsupported file type, unsupported MIME type, empty file, or file too large (>100MB).',
    type: BadRequestErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
  })
  async uploadReaderWorkSample(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<Media> {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error(
        'User ID not found in request. Ensure JWT authentication is properly configured.',
      );
    }

    return this.fileService.uploadReaderWorkSample(file, userId);
  }

  @Get('metadata/:key')
  @ApiOperation({
    summary: 'Get file metadata',
    description:
      'Retrieves metadata for a file stored in S3, including file size, content type, and upload date. The key should be URL-encoded if it contains special characters.',
  })
  @ApiParam({
    name: 'key',
    description: 'S3 object key (file path)',
    type: 'string',
    example: 'documents/1704067200000-document.pdf',
  })
  @ApiOkResponse({
    description: 'File metadata retrieved successfully',
    type: FileMetadataResponseDto,
    schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          example: 'documents/1704067200000-document.pdf',
        },
        url: {
          type: 'string',
          example:
            'https://bucket.s3.amazonaws.com/documents/1704067200000-document.pdf',
        },
        fileName: {
          type: 'string',
          example: 'document.pdf',
        },
        fileSize: {
          type: 'number',
          example: 1024000,
        },
        contentType: {
          type: 'string',
          example: 'application/pdf',
        },
        uploadedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00Z',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'File not found with the provided key',
    type: NotFoundErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 404,
        },
        message: {
          type: 'string',
          example:
            'File with key documents/1704067200000-document.pdf not found',
        },
        error: {
          type: 'string',
          example: 'Not Found',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request. Common errors: S3 bucket is not configured or failed to retrieve file metadata.',
    type: BadRequestErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 400,
        },
        message: {
          type: 'string',
          example: 'S3 bucket is not configured',
        },
        error: {
          type: 'string',
          example: 'Bad Request',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 401,
        },
        message: {
          type: 'string',
          example: 'Invalid or missing authentication token',
        },
        error: {
          type: 'string',
          example: 'Unauthorized',
        },
      },
    },
  })
  async getFileMetadata(@Param('key') key: string) {
    const decodedKey = decodeURIComponent(key);
    return this.fileService.getFileMetadata(decodedKey);
  }

  @Get('download/:key')
  @ApiOperation({
    summary: 'Download a file',
    description:
      'Downloads a file from S3. The file will be streamed to the client with appropriate content type and content disposition headers.',
  })
  @ApiParam({
    name: 'key',
    description: 'S3 object key (file path)',
    type: 'string',
    example: 'documents/1704067200000-document.pdf',
  })
  @ApiOkResponse({
    description:
      'File downloaded successfully. The response contains the file binary data with appropriate Content-Type, Content-Disposition, and Content-Length headers.',
    content: {
      'application/octet-stream': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'application/pdf': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'image/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'video/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'audio/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
    headers: {
      'Content-Type': {
        description: 'MIME type of the file',
        schema: {
          type: 'string',
          example: 'application/pdf',
        },
      },
      'Content-Disposition': {
        description: 'Indicates the file should be downloaded as an attachment',
        schema: {
          type: 'string',
          example: 'attachment; filename="document.pdf"',
        },
      },
      'Content-Length': {
        description: 'Size of the file in bytes',
        schema: {
          type: 'number',
          example: 1024000,
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'File not found with the provided key',
    type: NotFoundErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 404,
        },
        message: {
          type: 'string',
          example:
            'File with key documents/1704067200000-document.pdf not found',
        },
        error: {
          type: 'string',
          example: 'Not Found',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request. Common errors: S3 bucket is not configured or failed to download file.',
    type: BadRequestErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 400,
        },
        message: {
          type: 'string',
          example: 'S3 bucket is not configured',
        },
        error: {
          type: 'string',
          example: 'Bad Request',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 401,
        },
        message: {
          type: 'string',
          example: 'Invalid or missing authentication token',
        },
        error: {
          type: 'string',
          example: 'Unauthorized',
        },
      },
    },
  })
  async downloadFile(@Param('key') key: string, @Res() res: Response) {
    const decodedKey = decodeURIComponent(key);
    const { stream, metadata } =
      await this.fileService.downloadFile(decodedKey);

    res.setHeader('Content-Type', metadata.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${metadata.fileName}"`,
    );
    res.setHeader('Content-Length', metadata.fileSize);

    stream.pipe(res);
  }

  @Get('presigned/:key')
  @ApiOperation({
    summary: 'Get a presigned URL for a private S3 object',
    description:
      'Generates a short-lived presigned GET URL for a private S3 object. ' +
      'The frontend can use this URL directly (e.g. as a `<video src>`) without proxying through the backend. ' +
      'Expiry is configurable via `expiresIn` (seconds, 60–3600). Defaults to 1800s (30 min).',
  })
  @ApiParam({
    name: 'key',
    description: 'S3 object key (URL-encoded if it contains slashes)',
    type: 'string',
    example: 'recordings/session_123e4567.mp4',
  })
  @ApiQuery({
    name: 'expiresIn',
    description:
      'Presigned URL lifetime in seconds (60–3600). Defaults to 1800.',
    required: false,
    type: 'number',
    example: 1800,
  })
  @ApiOkResponse({
    description: 'Presigned URL generated successfully',
    schema: {
      example: {
        success: true,
        message: 'Presigned URL generated successfully',
        data: {
          url: 'https://bucket.s3.amazonaws.com/recordings/session_123e4567.mp4?X-Amz-Algorithm=...',
          expiresIn: 1800,
          expiresAt: '2026-04-16T15:30:00.000Z',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'S3 bucket not configured or failed to generate URL',
    type: BadRequestErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
  })
  async getPresignedUrl(
    @Param('key') key: string,
    @Query('expiresIn') expiresIn?: string,
  ) {
    const decodedKey = decodeURIComponent(key);
    const expiry = expiresIn ? parseInt(expiresIn, 10) : 1800;
    const result = await this.fileService.getPresignedUrl(decodedKey, expiry);
    return {
      success: true,
      message: 'Presigned URL generated successfully',
      data: result,
    };
  }

  @Get('stream/:key')
  @ApiOperation({
    summary: 'Stream a file',
    description:
      'Streams a file from S3 with support for range requests (partial content). Useful for video/audio streaming and resumable downloads. Supports HTTP Range headers for seeking.',
  })
  @ApiParam({
    name: 'key',
    description: 'S3 object key (file path)',
    type: 'string',
    example: 'videos/1704067200000-video.mp4',
  })
  @ApiQuery({
    name: 'start',
    description:
      'Start byte position for range request (optional). Can also be specified via Range header: "Range: bytes=start-end"',
    type: 'number',
    required: false,
    example: 0,
  })
  @ApiQuery({
    name: 'end',
    description:
      'End byte position for range request (optional). If omitted, streams until the end of file.',
    type: 'number',
    required: false,
    example: 1024000,
  })
  @ApiResponse({
    status: 200,
    description: 'File streamed successfully (full file or range request)',
    content: {
      'application/octet-stream': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'video/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'audio/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
    headers: {
      'Content-Type': {
        description: 'MIME type of the file',
        schema: {
          type: 'string',
          example: 'video/mp4',
        },
      },
      'Accept-Ranges': {
        description: 'Indicates support for range requests',
        schema: {
          type: 'string',
          example: 'bytes',
        },
      },
      'Content-Length': {
        description: 'Size of the requested range in bytes',
        schema: {
          type: 'number',
          example: 1024000,
        },
      },
    },
  })
  @ApiResponse({
    status: 206,
    description:
      'Partial content. Returned when a Range header is provided and the range is valid.',
    content: {
      'application/octet-stream': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'video/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
      'audio/*': {
        schema: {
          type: 'string',
          format: 'binary',
        },
      },
    },
    headers: {
      'Content-Range': {
        description: 'The range of bytes being returned',
        schema: {
          type: 'string',
          example: 'bytes 0-1023999/5242880',
        },
      },
      'Content-Type': {
        description: 'MIME type of the file',
        schema: {
          type: 'string',
          example: 'video/mp4',
        },
      },
      'Accept-Ranges': {
        description: 'Indicates support for range requests',
        schema: {
          type: 'string',
          example: 'bytes',
        },
      },
      'Content-Length': {
        description: 'Size of the requested range in bytes',
        schema: {
          type: 'number',
          example: 1024000,
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'File not found with the provided key',
    type: NotFoundErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 404,
        },
        message: {
          type: 'string',
          example: 'File with key videos/1704067200000-video.mp4 not found',
        },
        error: {
          type: 'string',
          example: 'Not Found',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request. Common errors: S3 bucket is not configured, invalid range parameters, or failed to stream file.',
    type: BadRequestErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 400,
        },
        message: {
          type: 'string',
          example: 'S3 bucket is not configured',
        },
        error: {
          type: 'string',
          example: 'Bad Request',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 401,
        },
        message: {
          type: 'string',
          example: 'Invalid or missing authentication token',
        },
        error: {
          type: 'string',
          example: 'Unauthorized',
        },
      },
    },
  })
  @Header('Accept-Ranges', 'bytes')
  async streamFile(
    @Param('key') key: string,
    @Req() req: any,
    @Res() res: Response,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    const decodedKey = decodeURIComponent(key);

    // Parse range header if present
    const rangeHeader = req.headers.range;
    let startByte: number | undefined;
    let endByte: number | undefined;

    if (rangeHeader) {
      const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (rangeMatch) {
        startByte = parseInt(rangeMatch[1], 10);
        endByte = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined;
      }
    } else if (start || end) {
      startByte = start ? parseInt(start, 10) : undefined;
      endByte = end ? parseInt(end, 10) : undefined;
    }

    const { stream, metadata, contentRange } =
      await this.fileService.streamFile(decodedKey, startByte, endByte);

    res.setHeader('Content-Type', metadata.contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
      res.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      res.setHeader('Content-Length', metadata.fileSize);
      res.status(HttpStatus.OK);
    }

    stream.pipe(res);
  }

  @Delete(':key')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a file',
    description:
      'Permanently deletes a file from S3 storage. This action cannot be undone.',
  })
  @ApiParam({
    name: 'key',
    description: 'S3 object key (file path)',
    type: 'string',
    example: 'documents/1704067200000-document.pdf',
  })
  @ApiNoContentResponse({
    description:
      'File deleted successfully. No content is returned (204 status code).',
  })
  @ApiNotFoundResponse({
    description: 'File not found with the provided key',
    type: NotFoundErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 404,
        },
        message: {
          type: 'string',
          example:
            'File with key documents/1704067200000-document.pdf not found',
        },
        error: {
          type: 'string',
          example: 'Not Found',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request. Common errors: S3 bucket is not configured or failed to delete file.',
    type: BadRequestErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 400,
        },
        message: {
          type: 'string',
          example: 'S3 bucket is not configured',
        },
        error: {
          type: 'string',
          example: 'Bad Request',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    type: UnauthorizedErrorResponseDto,
    schema: {
      type: 'object',
      properties: {
        statusCode: {
          type: 'number',
          example: 401,
        },
        message: {
          type: 'string',
          example: 'Invalid or missing authentication token',
        },
        error: {
          type: 'string',
          example: 'Unauthorized',
        },
      },
    },
  })
  async deleteFile(@Param('key') key: string) {
    const decodedKey = decodeURIComponent(key);
    await this.fileService.deleteFile(decodedKey);
  }
}
