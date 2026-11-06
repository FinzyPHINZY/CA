import { AttachSharedFileDto, JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SessionFilesService } from './session-files.service';

// ── Reusable schemas ─────────────────────────────────────────────────────
// Centralized so success + list + detail responses stay aligned and Scalar /
// Swagger UI render identical body shapes everywhere.

const SHARED_FILE_EXAMPLE = {
  id: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
  rehearsalId: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  uploaderUserId: '91e50219-127e-40db-aa18-7a96a8b9146d',
  fileName: 'audition-sides.pdf',
  fileSize: 184320,
  mimeType: 'application/pdf',
  extension: 'pdf',
  contentHash:
    'b3a9c8f7d1e2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b4',
  downloadUrl:
    'https://acr-prod.s3.amazonaws.com/media/scripts/1747756800000-audition-sides.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Signature=...',
  downloadUrlExpiresAt: '2026-05-20T15:15:00.000Z',
  analysisStatus: 'none',
  analysisRequestedBy: null,
  analysisRequestedAt: null,
  analysisCompletedAt: null,
  uploadedAt: '2026-05-20T15:00:00.000Z',
};

const SHARED_FILE_RESPONSE_SCHEMA = {
  type: 'object',
  example: SHARED_FILE_EXAMPLE,
  properties: {
    id: {
      type: 'string',
      format: 'uuid',
      example: SHARED_FILE_EXAMPLE.id,
    },
    rehearsalId: {
      type: 'string',
      format: 'uuid',
      example: SHARED_FILE_EXAMPLE.rehearsalId,
    },
    uploaderUserId: {
      type: 'string',
      format: 'uuid',
      example: SHARED_FILE_EXAMPLE.uploaderUserId,
    },
    fileName: { type: 'string', example: SHARED_FILE_EXAMPLE.fileName },
    fileSize: {
      type: 'number',
      example: SHARED_FILE_EXAMPLE.fileSize,
      description: 'Byte count',
    },
    mimeType: { type: 'string', example: SHARED_FILE_EXAMPLE.mimeType },
    extension: {
      type: 'string',
      example: SHARED_FILE_EXAMPLE.extension,
      description: 'Lowercase, no leading dot',
    },
    contentHash: {
      type: 'string',
      example: SHARED_FILE_EXAMPLE.contentHash,
      description: 'sha256 of the uploaded bytes',
    },
    downloadUrl: {
      type: 'string',
      example: SHARED_FILE_EXAMPLE.downloadUrl,
      description: 'Presigned S3 GET URL, 15-minute TTL',
    },
    downloadUrlExpiresAt: {
      type: 'string',
      format: 'date-time',
      example: SHARED_FILE_EXAMPLE.downloadUrlExpiresAt,
    },
    analysisStatus: {
      type: 'string',
      enum: ['none', 'pending', 'processing', 'completed', 'failed', 'cached'],
      example: SHARED_FILE_EXAMPLE.analysisStatus,
    },
    analysisRequestedBy: {
      type: 'string',
      format: 'uuid',
      nullable: true,
      example: SHARED_FILE_EXAMPLE.analysisRequestedBy,
    },
    analysisRequestedAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      example: SHARED_FILE_EXAMPLE.analysisRequestedAt,
    },
    analysisCompletedAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      example: SHARED_FILE_EXAMPLE.analysisCompletedAt,
    },
    uploadedAt: {
      type: 'string',
      format: 'date-time',
      example: SHARED_FILE_EXAMPLE.uploadedAt,
    },
  },
};

const ANALYSIS_RESULT_EXAMPLE = {
  title: 'The Audition',
  format: 'pdf_text',
  scenes: [
    {
      number: 1,
      heading: 'INT. CASTING ROOM - DAY',
      elements: [
        { type: 'action', text: 'JANE enters, nervous.' },
        { type: 'character', text: 'JANE', character_name: 'JANE' },
        { type: 'dialogue', text: 'I’m ready when you are.' },
      ],
    },
  ],
  characters: [{ name: 'JANE', line_count: 12 }],
  page_count: 4,
  structure_confidence_score: 0.94,
};

const ANALYSIS_STATE_SCHEMA = {
  type: 'object',
  example: {
    sharedFileId: SHARED_FILE_EXAMPLE.id,
    status: 'completed',
    result: ANALYSIS_RESULT_EXAMPLE,
    error: null,
    requestedBy: SHARED_FILE_EXAMPLE.uploaderUserId,
    requestedAt: '2026-05-20T15:02:00.000Z',
    completedAt: '2026-05-20T15:02:14.000Z',
  },
  properties: {
    sharedFileId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['none', 'pending', 'processing', 'completed', 'failed', 'cached'],
    },
    result: {
      type: 'object',
      nullable: true,
      description:
        'ScriptParserResultPayload — same shape as Phase 4.0 analysis output. Present only when status is `completed` or `cached`.',
    },
    error: { type: 'string', nullable: true, example: null },
    requestedBy: { type: 'string', format: 'uuid', nullable: true },
    requestedAt: { type: 'string', format: 'date-time', nullable: true },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
  },
};

// ── Error schemas (concrete bodies the FE will receive) ─────────────────

const UNAUTHORIZED_ERROR = {
  type: 'object',
  example: {
    statusCode: 401,
    message: 'Unauthorized',
    error: 'Unauthorized',
  },
  properties: {
    statusCode: { type: 'number', example: 401 },
    message: { type: 'string' },
    error: { type: 'string' },
  },
};

const NOT_PARTICIPANT_ERROR = {
  type: 'object',
  example: {
    statusCode: 403,
    code: 'NOT_PARTICIPANT',
    message: 'You are not a participant of this rehearsal session.',
  },
  properties: {
    statusCode: { type: 'number', example: 403 },
    code: { type: 'string', example: 'NOT_PARTICIPANT' },
    message: { type: 'string' },
  },
};

const NOT_UPLOADER_ERROR = {
  type: 'object',
  example: {
    statusCode: 403,
    message: 'Only the uploader can delete a shared file.',
    error: 'Forbidden',
  },
  properties: {
    statusCode: { type: 'number', example: 403 },
    message: { type: 'string' },
    error: { type: 'string', example: 'Forbidden' },
  },
};

const NOT_FOUND_ERROR = {
  type: 'object',
  example: {
    statusCode: 404,
    message:
      'Shared file 7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c not found in this session',
    error: 'Not Found',
  },
  properties: {
    statusCode: { type: 'number', example: 404 },
    message: { type: 'string' },
    error: { type: 'string', example: 'Not Found' },
  },
};

const RATE_LIMIT_ERROR = {
  type: 'object',
  example: {
    statusCode: 429,
    code: 'RATE_LIMIT_EXCEEDED',
    message:
      'Per-session file cap reached (20). Delete a file before sharing another.',
  },
  properties: {
    statusCode: { type: 'number', example: 429 },
    code: { type: 'string', example: 'RATE_LIMIT_EXCEEDED' },
    message: { type: 'string' },
  },
};

const SESSION_NOT_ACTIVE_ERROR = {
  type: 'object',
  example: {
    statusCode: 400,
    code: 'SESSION_NOT_ACTIVE',
    message:
      'Files can only be shared while the session is ACTIVE (current status: PAUSED).',
  },
  properties: {
    statusCode: { type: 'number', example: 400 },
    code: {
      type: 'string',
      enum: [
        'SESSION_NOT_ACTIVE',
        'UNSUPPORTED_REHEARSAL_MODE',
        'MISSING_BOOKING',
      ],
    },
    message: { type: 'string' },
  },
};

const VALIDATION_ERROR = {
  type: 'object',
  example: {
    statusCode: 400,
    message: ['fileId must be a UUID', 'clientUploadId must be a UUID'],
    error: 'Bad Request',
  },
  properties: {
    statusCode: { type: 'number', example: 400 },
    message: { type: 'array', items: { type: 'string' } },
    error: { type: 'string', example: 'Bad Request' },
  },
};

@ApiTags('Session Shared Files')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('rehearsals/:rehearsalId/shared-files')
export class SessionFilesController {
  constructor(private readonly sessionFilesService: SessionFilesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Attach an uploaded file to the live reader session',
    description: [
      'Two-step share flow:',
      '1. Upload the raw file via `POST /api/files/upload` (or `/upload/script` for stricter screenplay validation) — receive a Media row with `id` and `contentHash`.',
      '2. Call this endpoint with that `id` as `fileId` plus a fresh `clientUploadId` UUID.',
      '',
      'Both participants of the booking receive a `session.file_shared` Socket.io event on the `/session` namespace (room keyed by `bookingId`) and should refetch `GET /shared-files`.',
      '',
      'Idempotent — repeat calls with the same `clientUploadId` return the existing row instead of creating duplicates.',
      '',
      'Constraints:',
      '- Rehearsal must be `mode=READER_BOOKED` and `status=ACTIVE`.',
      '- Caller must be the booking actor or reader.',
      '- Caller must be the user who uploaded the Media row.',
      '- Max 20 active files per session.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'rehearsalId',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  })
  @ApiBody({
    type: AttachSharedFileDto,
    examples: {
      pdf: {
        summary: 'Share a PDF script',
        value: {
          fileId: '2204637c-1beb-47d6-a7fc-11fb556d9480',
          clientUploadId: '6f066323-bdbb-465d-81dc-7621d779d34f',
          fileName: 'audition-sides.pdf',
        },
      },
      minimal: {
        summary: 'Minimal — no fileName override',
        value: {
          fileId: '2204637c-1beb-47d6-a7fc-11fb556d9480',
          clientUploadId: '6f066323-bdbb-465d-81dc-7621d779d34f',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'File attached. Both participants will receive `session.file_shared` on the `/session` Socket.io namespace.',
    schema: SHARED_FILE_RESPONSE_SCHEMA,
  })
  @ApiBadRequestResponse({
    description:
      'Validation error, missing S3 reference on the Media row, rehearsal not READER_BOOKED, or session not ACTIVE.',
    schema: SESSION_NOT_ACTIVE_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing JWT',
    schema: UNAUTHORIZED_ERROR,
  })
  @ApiForbiddenResponse({
    description:
      'Caller is not a participant of this rehearsal, or is attempting to share a Media row uploaded by someone else.',
    schema: NOT_PARTICIPANT_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Rehearsal or `fileId` Media row not found',
    schema: NOT_FOUND_ERROR,
  })
  @ApiTooManyRequestsResponse({
    description:
      'Per-session file cap reached (20). Delete one to free a slot.',
    schema: RATE_LIMIT_ERROR,
  })
  async attach(
    @Req() req: any,
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
    @Body(ValidationPipe) dto: AttachSharedFileDto,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request.');
    return this.sessionFilesService.attach(rehearsalId, userId, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List shared files for the live reader session',
    description:
      'Returns active (non-deleted) shared files in upload order. Each item carries a freshly signed S3 download URL valid for 15 minutes — refetch this endpoint when URLs expire.',
  })
  @ApiParam({
    name: 'rehearsalId',
    type: 'string',
    format: 'uuid',
    example: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  })
  @ApiOkResponse({
    description: 'Active shared files',
    schema: {
      type: 'array',
      items: SHARED_FILE_RESPONSE_SCHEMA,
      example: [SHARED_FILE_EXAMPLE],
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing JWT',
    schema: UNAUTHORIZED_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant',
    schema: NOT_PARTICIPANT_ERROR,
  })
  async list(
    @Req() req: any,
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request.');
    return this.sessionFilesService.list(rehearsalId, userId);
  }

  @Get(':fileId')
  @ApiOperation({
    summary: 'Get a single shared file',
    description:
      'Returns one shared file with a freshly signed S3 download URL (15-minute TTL).',
  })
  @ApiParam({
    name: 'rehearsalId',
    type: 'string',
    format: 'uuid',
    example: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  })
  @ApiParam({
    name: 'fileId',
    type: 'string',
    format: 'uuid',
    example: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
  })
  @ApiOkResponse({
    description: 'Shared file detail',
    schema: SHARED_FILE_RESPONSE_SCHEMA,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing JWT',
    schema: UNAUTHORIZED_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant',
    schema: NOT_PARTICIPANT_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Shared file not found in this session',
    schema: NOT_FOUND_ERROR,
  })
  async get(
    @Req() req: any,
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request.');
    return this.sessionFilesService.get(rehearsalId, fileId, userId);
  }

  @Delete(':fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a shared file from the session',
    description:
      'Soft-deletes the row (S3 + DB hard-delete happens 24h later via retention cron). Only the uploader may delete their own file. Other participants receive `session.file_deleted` on Socket.io and should refetch the list.',
  })
  @ApiParam({
    name: 'rehearsalId',
    type: 'string',
    format: 'uuid',
    example: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  })
  @ApiParam({
    name: 'fileId',
    type: 'string',
    format: 'uuid',
    example: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
  })
  @ApiNoContentResponse({ description: 'File deleted' })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing JWT',
    schema: UNAUTHORIZED_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant or is not the uploader',
    schema: NOT_UPLOADER_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Shared file not found in this session',
    schema: NOT_FOUND_ERROR,
  })
  async remove(
    @Req() req: any,
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request.');
    return this.sessionFilesService.softDelete(rehearsalId, fileId, userId);
  }

  @Post(':fileId/analyze')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run script analysis on a shared file',
    description: [
      'Dispatches the file through the Phase 4.0 parser pipeline (script_parser → ai_service).',
      '',
      'Returns one of:',
      '- `status: "pending"` (202) — fresh dispatch. Listen for `session.file_analyzed` Socket.io event or poll `GET /:fileId/analysis`.',
      '- `status: "cached"` (202, `result` populated synchronously) — same bytes (sha256) already analyzed in any past session.',
      '- `status: "completed"` (202, `result` populated synchronously) — this row was already analyzed earlier in this session.',
      '',
      'Available to all authenticated participants — no premium gate at this time.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'rehearsalId',
    type: 'string',
    format: 'uuid',
    example: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  })
  @ApiParam({
    name: 'fileId',
    type: 'string',
    format: 'uuid',
    example: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
  })
  @ApiResponse({
    status: 202,
    description: 'Analysis dispatched or served from cache',
    schema: {
      type: 'object',
      properties: {
        sharedFileId: { type: 'string', format: 'uuid' },
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'completed', 'cached'],
        },
        result: {
          type: 'object',
          nullable: true,
          description:
            'Present when status is `cached` or `completed`. Throwaway parse result — not persisted as project content.',
        },
      },
      examples: {
        pending: {
          summary: 'Fresh dispatch — listen on socket or poll',
          value: {
            sharedFileId: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
            status: 'pending',
          },
        },
        cached: {
          summary: 'Cache hit — result returned synchronously',
          value: {
            sharedFileId: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
            status: 'cached',
            result: ANALYSIS_RESULT_EXAMPLE,
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Session not active or not a READER_BOOKED rehearsal',
    schema: SESSION_NOT_ACTIVE_ERROR,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing JWT',
    schema: UNAUTHORIZED_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant',
    schema: NOT_PARTICIPANT_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Shared file not found in this session',
    schema: NOT_FOUND_ERROR,
  })
  async analyze(
    @Req() req: any,
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request.');
    return this.sessionFilesService.analyze(rehearsalId, fileId, userId);
  }

  @Get(':fileId/analysis')
  @ApiOperation({
    summary: 'Poll the current analysis state for a shared file',
    description:
      'Fallback to the `session.file_analyzed` Socket.io event. Returns the row’s current analysis fields verbatim.',
  })
  @ApiParam({
    name: 'rehearsalId',
    type: 'string',
    format: 'uuid',
    example: '5789980b-1403-4724-b3aa-7fcb20a9e84d',
  })
  @ApiParam({
    name: 'fileId',
    type: 'string',
    format: 'uuid',
    example: '7f3a9c5e-1b2d-4e8a-9f1c-3d4e5f6a7b8c',
  })
  @ApiOkResponse({
    description: 'Analysis state',
    schema: ANALYSIS_STATE_SCHEMA,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing JWT',
    schema: UNAUTHORIZED_ERROR,
  })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant',
    schema: NOT_PARTICIPANT_ERROR,
  })
  @ApiNotFoundResponse({
    description: 'Shared file not found in this session',
    schema: NOT_FOUND_ERROR,
  })
  async getAnalysis(
    @Req() req: any,
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    const userId = req.user?.id;
    if (!userId)
      throw new UnauthorizedException('User ID not found in request.');
    return this.sessionFilesService.getAnalysis(rehearsalId, fileId, userId);
  }
}
