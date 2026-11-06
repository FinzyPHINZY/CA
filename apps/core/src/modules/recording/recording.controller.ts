/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  JwtAuthGuard,
  PaginationQueryDto,
  RecordingMode,
  RecordingStatus,
  RecordingTypeEnum,
} from '@app/common';
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
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CreateRecordingDto } from './dto/create-recording.dto';
import { HazelTokenRequestDto } from './dto/hazel-token-request.dto';
import { ListRecordingsQueryDto } from './dto/list-recordings-query.dto';
import { UpdateRecordingDto } from './dto/update-recording.dto';
import { RecordingService } from './recording.service';

const RECORDING_SAMPLE = {
  id: '7c2f9b1e-1234-4abc-9def-0123456789ab',
  titleCard: 'Scene 1 - Opening',
  type: 'AI_PARTNER',
  mode: 'ai_rehearsal',
  status: 'ready',
  agoraChannelId: 'rec_7c2f9b1e',
  agoraResourceId: 'agora_resource_abc123',
  cloudRecordingSid: 'sid_xyz789',
  projectId: '11111111-1111-1111-1111-111111111111',
  scriptId: '22222222-2222-2222-2222-222222222222',
  sceneId: '33333333-3333-3333-3333-333333333333',
  userId: '44444444-4444-4444-4444-444444444444',
  rehearsalId: '55555555-5555-5555-5555-555555555555',
  summary: 'Take 2 — strong on the second beat.',
  durationMs: 132000,
  metaData: { takeNumber: 2, notes: 'best take' },
  createdAt: '2026-04-18T10:15:00.000Z',
  updatedAt: '2026-04-18T10:17:12.000Z',
  project: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'My Audition Pack',
    description: 'Spring 2026 reel',
    visibility: 'private',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: '2026-04-10T12:00:00.000Z',
  },
  script: {
    id: '22222222-2222-2222-2222-222222222222',
    title: 'The Last Letter',
    status: 'analyzed',
    defaultCharacterId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    createdAt: '2026-03-02T08:00:00.000Z',
    updatedAt: '2026-03-02T08:30:00.000Z',
  },
  scene: {
    id: '33333333-3333-3333-3333-333333333333',
    title: 'Scene 1 - Opening',
    sceneNumber: '1',
    summary: 'Sarah enters the empty kitchen.',
    createdAt: '2026-03-02T08:30:00.000Z',
    updatedAt: '2026-03-02T08:30:00.000Z',
  },
  rehearsal: {
    id: '55555555-5555-5555-5555-555555555555',
    status: 'COMPLETED',
    createdAt: '2026-04-18T10:14:00.000Z',
    updatedAt: '2026-04-18T10:17:12.000Z',
  },
  takes: [
    {
      id: '66666666-6666-6666-6666-666666666666',
      type: 'video',
      url: 'https://bucket.s3.amazonaws.com/recordings/take-1.mp4',
      playbackUrl:
        'https://cdn.example.com/recordings/take-1.mp4?Expires=…&Signature=…',
      size: 24576000,
      fileName: 'take-1.mp4',
      contentType: 'video/mp4',
      durationMs: 132000,
      createdAt: '2026-04-18T10:17:00.000Z',
    },
  ],
  mediaResources: [
    {
      id: '77777777-7777-7777-7777-777777777777',
      type: 'audio',
      url: 'https://bucket.s3.amazonaws.com/recordings/scratch-audio.m4a',
      playbackUrl:
        'https://cdn.example.com/recordings/scratch-audio.m4a?Expires=…&Signature=…',
      size: 2048000,
      fileName: 'scratch-audio.m4a',
      contentType: 'audio/mp4',
      durationMs: 132000,
      createdAt: '2026-04-18T10:17:00.000Z',
    },
  ],
};

const PAGINATED_RECORDINGS_SAMPLE = {
  success: true,
  message: 'Recordings retrieved successfully',
  data: {
    items: [RECORDING_SAMPLE],
    total: 1,
    page: 1,
    limit: 10,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  },
};

@ApiTags('Recordings')
@Controller('recordings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class RecordingController {
  constructor(private readonly recordingService: RecordingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new recording',
    description:
      'Creates a new recording for a scene in a project. The recording can include takes (media files) and media resources. All referenced entities (project, script, scene) must exist and belong to the authenticated user.',
  })
  @ApiBody({
    description: 'Recording creation data',
    type: CreateRecordingDto,
  })
  @ApiCreatedResponse({
    description: 'Recording created successfully',
    schema: {
      example: {
        success: true,
        message: 'Recording created successfully',
        data: {
          id: 'uuid',
          titleCard: 'Scene 1 - Opening',
          type: 'AI_PARTNER',
          projectId: 'uuid',
          scriptId: 'uuid',
          sceneId: 'uuid',
          userId: 'uuid',
          takes: [],
          mediaResources: [],
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid recording data or validation failed',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            {
              type: 'array',
              items: { type: 'string' },
            },
          ],
          example: [
            'Project ID is required',
            'Scene does not belong to the specified project',
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to create recordings for this project',
  })
  async createRecording(
    @Req() req: any,
    @Body(ValidationPipe) createRecordingDto: CreateRecordingDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.recordingService.createRecording(userId, createRecordingDto);
  }

  @Get('script/:scriptId')
  @ApiOperation({
    summary: 'Get all recordings for a script',
    description:
      'Retrieves all recordings associated with a specific script with pagination, search, sort, and filter capabilities. ' +
      '**Search** is case-insensitive and matches against recording title card and summary. ' +
      'Use **sortBy** (e.g. createdAt, updatedAt, titleCard) and **sortOrder** (ASC/DESC) to order results. ' +
      'Same pattern as rehearsals by script.',
  })
  @ApiParam({
    name: 'scriptId',
    description: 'Script unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Default: 1',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100). Default: 10',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter recordings by title card or summary (case-insensitive partial match). Omit for no search filter.',
    example: 'opening',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'titleCard'],
    description:
      'Field to sort by. Allowed: createdAt, updatedAt, titleCard. Default: createdAt',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: DESC',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of recordings for the script',
    schema: {
      example: PAGINATED_RECORDINGS_SAMPLE,
    },
  })
  @ApiNotFoundResponse({
    description: 'Script not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Script with ID 223e4567-e89b-12d3-a456-426614174001 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid query parameters (e.g. invalid page, limit, sortBy, or sortOrder)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getRecordingsByScriptId(
    @Param('scriptId') scriptId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.recordingService.findByScriptIdPaginated(scriptId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get recording by ID',
    description:
      'Retrieves a single recording by its unique identifier with all related entities (project, script, scene, user, takes, media resources).',
  })
  @ApiParam({
    name: 'id',
    description: 'Recording unique identifier',
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description:
      'Recording retrieved successfully. Includes loaded relations: project, script, scene, takes, mediaResources, and rehearsal (when applicable). Each take and mediaResource includes a signed `playbackUrl` (CloudFront, ~24h expiry) — use this to play the file, not the raw `url`. `userId` is a plain UUID — fetch user details from the auth service via API composition (no DB join across schemas).',
    schema: {
      example: {
        success: true,
        message: 'Recording retrieved successfully',
        data: RECORDING_SAMPLE,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Recording with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getRecordingById(@Param('id', ParseUUIDPipe) id: string) {
    return this.recordingService.getRecordingByIdForResponse(id);
  }

  @Get('project/:projectId')
  @ApiOperation({
    summary: 'Get all recordings for a project',
    description:
      'Retrieves all recordings associated with a specific project with pagination, search, sort, and filter capabilities.',
  })
  @ApiParam({
    name: 'projectId',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Default: 1',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (1-100). Default: 10',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term (matches titleCard and summary, case-insensitive)',
    example: 'opening',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'titleCard'],
    description: 'Sort field. Default: createdAt',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: DESC',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of recordings for the project',
    schema: {
      example: PAGINATED_RECORDINGS_SAMPLE,
    },
  })
  @ApiNotFoundResponse({
    description: 'Project not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Project with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getRecordingsByProjectId(
    @Param('projectId') projectId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.recordingService.findByProjectIdPaginated(projectId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('scene/:sceneId')
  @ApiOperation({
    summary: 'Get all recordings for a scene',
    description:
      'Retrieves all recordings associated with a specific scene with pagination, search, sort, and filter capabilities.',
  })
  @ApiParam({
    name: 'sceneId',
    description: 'Scene unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Default: 1',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (1-100). Default: 10',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term (matches titleCard and summary, case-insensitive)',
    example: 'opening',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'titleCard'],
    description: 'Sort field. Default: createdAt',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: DESC',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of recordings for the scene',
    schema: {
      example: PAGINATED_RECORDINGS_SAMPLE,
    },
  })
  @ApiNotFoundResponse({
    description: 'Scene not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Scene with ID 323e4567-e89b-12d3-a456-426614174002 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getRecordingsBySceneId(
    @Param('sceneId') sceneId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.recordingService.findBySceneIdPaginated(sceneId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Post('hazel/token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate an Agora RTC token for a Hazel recording channel',
    description:
      'Returns an Agora token + appId + uid so the actor can join the recording channel and publish their mic/camera streams. The channel name is derived deterministically as `hazel_rec_{rehearsalId}` — do NOT pass an arbitrary channel name. Caller must own the rehearsal.',
  })
  @ApiBody({ type: HazelTokenRequestDto })
  @ApiOkResponse({
    description: 'Token generated successfully',
    schema: {
      example: {
        success: true,
        message: 'Hazel recording token generated successfully',
        data: {
          token: '006xxxxxx...',
          uid: 1234567890,
          channelName: 'hazel_rec_55555555-5555-5555-5555-555555555555',
          appId: 'abcdef0123456789...',
          expiresIn: 3600,
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Rehearsal not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Rehearsal with ID 55555555-5555-5555-5555-555555555555 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User does not own the rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to record this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async generateHazelToken(
    @Req() req: any,
    @Body(ValidationPipe) dto: HazelTokenRequestDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    const tokenResult = await this.recordingService.generateHazelRecordingToken(
      dto.rehearsalId,
      userId,
    );
    return {
      success: true,
      message: 'Hazel recording token generated successfully',
      data: tokenResult,
    };
  }

  @Get('rehearsal/:rehearsalId')
  @ApiOperation({
    summary: 'Get all recordings for a rehearsal session',
    description:
      'Retrieves all recordings produced during a specific rehearsal session (Hazel AI rehearsal or reader session) with pagination, search, sort, and filter capabilities. Each take and mediaResource includes a signed `playbackUrl`.',
  })
  @ApiParam({
    name: 'rehearsalId',
    description: 'Rehearsal unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '55555555-5555-5555-5555-555555555555',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Default: 1',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (1-100). Default: 10',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term (matches titleCard and summary, case-insensitive)',
    example: 'take 2',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'titleCard'],
    description: 'Sort field. Default: createdAt',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: DESC',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of recordings for the rehearsal',
    schema: {
      example: PAGINATED_RECORDINGS_SAMPLE,
    },
  })
  @ApiNotFoundResponse({
    description: 'Rehearsal not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Rehearsal with ID 55555555-5555-5555-5555-555555555555 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async getRecordingsByRehearsalId(
    @Param('rehearsalId', ParseUUIDPipe) rehearsalId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.recordingService.findByRehearsalIdPaginated(rehearsalId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('project/:projectId/scene/:sceneId')
  @ApiOperation({
    summary: 'Get recordings by project and scene',
    description:
      'Retrieves all recordings for a specific scene within a project with pagination, search, sort, and filter capabilities.',
  })
  @ApiParam({
    name: 'projectId',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiParam({
    name: 'sceneId',
    description: 'Scene unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Default: 1',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (1-100). Default: 10',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term (matches titleCard and summary, case-insensitive)',
    example: 'opening',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'titleCard'],
    description: 'Sort field. Default: createdAt',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: DESC',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of recordings for the project and scene',
    schema: {
      example: PAGINATED_RECORDINGS_SAMPLE,
    },
  })
  @ApiNotFoundResponse({
    description: 'Project or scene not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Project or scene not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getRecordingsByProjectAndScene(
    @Param('projectId') projectId: string,
    @Param('sceneId') sceneId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.recordingService.findByProjectIdAndSceneIdPaginated(
      projectId,
      sceneId,
      {
        page: paginationQuery.page,
        limit: paginationQuery.limit,
        search: paginationQuery.search,
        sortBy: paginationQuery.sortBy,
        sortOrder: paginationQuery.sortOrder,
      },
    );
  }

  @Get('me/all')
  @ApiOperation({
    summary: 'Get all recordings for the authenticated user',
    description:
      'Retrieves all recordings associated with the currently authenticated user with pagination, search, sort, and filter capabilities.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed). Default: 1',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (1-100). Default: 10',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term (matches titleCard and summary, case-insensitive)',
    example: 'opening',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'titleCard'],
    description: 'Sort field. Default: createdAt',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: DESC',
    example: 'DESC',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: RecordingTypeEnum,
    description:
      'Filter by recording type. AI_PARTNER = AI rehearsal partner, READER = paid human reader session, SOLO = solo teleprompter or self-tape. Rejected with 400 if value is outside the enum.',
    example: RecordingTypeEnum.SOLO,
  })
  @ApiQuery({
    name: 'mode',
    required: false,
    enum: RecordingMode,
    description:
      'Filter by recording mode. Must be one of: ai_rehearsal, reader_session, solo_teleprompter, self_tape. Rejected with 400 if value is outside the enum.',
    example: RecordingMode.SELF_TAPE,
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: RecordingStatus,
    description:
      'Filter by recording lifecycle status. Must be one of: pending, recording, processing, ready, failed. Rejected with 400 if value is outside the enum.',
    example: RecordingStatus.READY,
  })
  @ApiOkResponse({
    description:
      'Paginated list of recordings for the authenticated user. For items where type=READER and mode=reader_session, a `counterparty` object is attached containing actor and reader details (fullName, avatar, avgRating, totalReviews). For all other items, `counterparty` is null.',
    schema: {
      example: PAGINATED_RECORDINGS_SAMPLE,
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  async getMyRecordings(
    @Req() req: any,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
    @Query(ValidationPipe) filters: ListRecordingsQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.recordingService.findByUserIdPaginated(userId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
      type: filters.type,
      mode: filters.mode,
      status: filters.status,
    });
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update recording',
    description:
      'Updates an existing recording. Only provided fields will be updated. The user must own the recording.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recording unique identifier',
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Recording update data',
    type: UpdateRecordingDto,
  })
  @ApiOkResponse({
    description: 'Recording updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Recording updated successfully',
        data: {
          id: 'uuid',
          titleCard: 'Scene 1 - Opening',
          type: 'AI_PARTNER',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
  })
  @ApiBadRequestResponse({
    description: 'Invalid update data',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to update this recording',
  })
  async updateRecording(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Body(ValidationPipe) updateRecordingDto: UpdateRecordingDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.recordingService.updateRecording(
      id,
      userId,
      updateRecordingDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete recording',
    description:
      'Permanently deletes a recording and all associated data. The user must own the recording. This action cannot be undone.',
  })
  @ApiParam({
    name: 'id',
    description: 'Recording unique identifier',
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiNoContentResponse({
    description: 'Recording deleted successfully. No content returned.',
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Recording with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to delete this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to delete this recording',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async deleteRecording(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.recordingService.deleteRecording(id, userId);
  }

  // get a signed playback URL for a recording's primary media
  @Get(':id/playback')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get playback URL',
    description:
      "Returns a signed CloudFront URL for the recording's primary media (first take or first media resource). The user must own the recording. **Signed URLs expire — always fetch a fresh URL immediately before playback. Do not cache or store the URL.**",
  })
  @ApiParam({
    name: 'id',
    description: 'Recording unique identifier',
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Signed playback URL with metadata',
    schema: {
      example: {
        success: true,
        message: 'Playback URL generated successfully',
        data: {
          url: 'https://cdn.example.com/recordings/file.mp4?...',
          durationMs: 120000,
          metaData: null,
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording or playable media not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'No playable media found for recording 123e4567-e89b-12d3-a456-426614174000',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to access this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to access this recording',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getPlaybackUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.recordingService.getPlaybackUrl(id, userId);
  }

  // get all quality variants for a recording with signed URLs
  @Get(':id/variants')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get recording variants',
    description:
      'Returns all available quality variants (takes and media resources) for a recording, each with a signed CloudFront URL. The user must own the recording. Use variants to offer quality options in your video player (original, 720p, audio-only).',
  })
  @ApiParam({
    name: 'id',
    description: 'Recording unique identifier',
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'All quality variants with signed URLs',
    schema: {
      example: {
        success: true,
        message: 'Recording variants retrieved successfully',
        data: {
          variants: [
            {
              id: 'uuid',
              fileName: 'take1.mp4',
              contentType: 'video/mp4',
              size: 24576000,
              durationMs: 132000,
              url: 'https://cdn.example.com/...',
              type: 'take',
            },
          ],
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Recording with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to access this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to access this recording',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getVariants(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.recordingService.getVariants(id, userId);
  }
}
