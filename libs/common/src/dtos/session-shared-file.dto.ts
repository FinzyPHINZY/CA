import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

// POST /api/rehearsals/:id/shared-files — attach an already-uploaded file.
// `fileId` is the id returned by file_service after the multipart upload.
// `clientUploadId` is an FE-generated uuid for idempotent retries.
export class AttachSharedFileDto {
  @ApiProperty({
    description:
      'UUID of the Media row returned by `POST /api/files/upload` (or `/upload/script`). The caller must be the user who uploaded the Media.',
    format: 'uuid',
    example: '2204637c-1beb-47d6-a7fc-11fb556d9480',
  })
  @IsUUID()
  fileId: string;

  @ApiProperty({
    description:
      'FE-generated UUID for idempotent attach retries. Same key + same rehearsal + same uploader = same row.',
    format: 'uuid',
    example: '6f066323-bdbb-465d-81dc-7621d779d34f',
  })
  @IsUUID()
  clientUploadId: string;

  @ApiPropertyOptional({
    description:
      'Display name override. Defaults to the Media row’s fileName when omitted.',
    minLength: 1,
    maxLength: 255,
    example: 'audition-sides.pdf',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName?: string;
}

// Response shape for list/get endpoints.
export interface SharedFileResponseDto {
  id: string;
  rehearsalId: string;
  uploaderUserId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  extension: string;
  contentHash: string;
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  analysisStatus:
    | 'none'
    | 'pending'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'cached';
  analysisRequestedBy: string | null;
  analysisRequestedAt: string | null;
  analysisCompletedAt: string | null;
  uploadedAt: string;
}

// Response shape returned by POST /:fileId/analyze. Cache hits return
// status=cached + immediate result; misses return status=pending with the
// expectation that the FE will poll or listen on the socket for completion.
export interface AnalyzeFileResponseDto {
  sharedFileId: string;
  status: 'pending' | 'processing' | 'completed' | 'cached';
  result?: Record<string, any>;
}

// Returned by GET /:fileId/analysis. Decoupled from the attach response so
// the FE can poll narrowly without re-pulling presigned URLs.
export interface SharedFileAnalysisDto {
  sharedFileId: string;
  status: 'none' | 'pending' | 'processing' | 'completed' | 'failed' | 'cached';
  result: Record<string, any> | null;
  error: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  completedAt: string | null;
}
