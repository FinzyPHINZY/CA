import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  ValidationPipe,
  UseGuards,
  Req,
  Query,
  ForbiddenException,
  UnauthorizedException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { RehearsalService } from './rehearsal.service';
import { RehearsalAnalyticsService } from './rehearsal-analytics.service';
import { RehearsalReviewService } from './rehearsal-review.service';
import { RehearsalSettingsService } from './rehearsal-settings.service';
import { UpdateRehearsalSettingsDto } from './dto/update-rehearsal-settings.dto';
import {
  CreateRehearsalReviewDto,
  UpdateRehearsalReviewDto,
} from './dto/create-rehearsal-review.dto';
import { CreateRehearsalDto } from './dto/create-rehearsal.dto';
import { CreateTeleprompterRehearsalDto } from './dto/create-teleprompter-rehearsal.dto';
import { ConfigureRehearsalSetupDto } from './dto/configure-rehearsal-setup.dto';
import { UpdateRehearsalDto } from './dto/update-rehearsal.dto';
import {
  Feature,
  FeatureGuard,
  JwtAuthGuard,
  RequireFeature,
} from '@app/common';
import {
  ListRehearsalsByUserIdQueryDto,
  RehearsalListSortBy,
  RehearsalListSortOrder,
} from './dto/list-rehearsals-by-user-query.dto';
import {
  RehearsalPaginationQueryDto,
  RehearsalSortField,
  RehearsalSortOrder,
} from './dto/pagination-query.dto';
import { RehearsalPartnerType } from '@app/common';
import { RehearsalListService } from './rehearsal-list.service';

// Response shape for GET/PUT /rehearsals/:id/settings. Single source of truth
// for the OpenAPI schema so the two endpoints stay aligned.
const SETTINGS_DATA_SCHEMA = {
  type: 'object',
  properties: {
    effective: {
      type: 'object',
      description: 'Resolved session settings',
      properties: {
        detectionMode: {
          type: 'string',
          enum: ['AUTO', 'LISTEN', 'MANUAL'],
          example: 'AUTO',
        },
        wordTracking: { type: 'boolean', example: false },
        autoRecord: { type: 'boolean', example: false },
        loopMode: { type: 'boolean', example: false },
      },
    },
    frozen: {
      type: 'boolean',
      example: false,
      description:
        'True only while playback is live (status ACTIVE or PAUSED). In any other state the response is re-resolved from override + user defaults so pending edits are visible.',
    },
    voiceMap: {
      type: 'object',
      nullable: true,
      additionalProperties: { type: 'string' },
      description:
        'characterId (UUID) → ElevenLabs voiceId. null if voices have never been configured for this rehearsal.',
      example: {
        '423e4567-e89b-12d3-a456-426614174003': 'TxGEqnHWrfWFTfGW9XjX',
      },
    },
    voiceMapFrozen: {
      type: 'boolean',
      example: false,
      description:
        'True once rehearsal is ACTIVE/PAUSED — voice dropdowns should be read-only',
    },
    characters: {
      type: 'array',
      description:
        'Non-actor characters in the script — one voice dropdown per entry',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'HAMLET' },
        },
      },
    },
  },
};

// Enriched review item shape. Shared across create/update/list review endpoints.
const REVIEW_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    rehearsalId: { type: 'string', format: 'uuid' },
    reviewerUserId: { type: 'string', format: 'uuid' },
    revieweeUserId: { type: 'string', format: 'uuid' },
    rating: { type: 'number', example: 5 },
    comment: { type: 'string', nullable: true, example: 'Great partner' },
    reviewer: {
      type: 'object',
      nullable: true,
      description: 'Reviewer profile; null if the account has been deleted',
      properties: {
        id: { type: 'string', format: 'uuid' },
        fullName: { type: 'string', nullable: true, example: 'Jane Doe' },
        avatar: {
          type: 'string',
          nullable: true,
          example: 'https://example.com/avatar.jpg',
        },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

@ApiTags('Rehearsals')
@Controller('rehearsals')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class RehearsalController {
  constructor(
    private readonly rehearsalService: RehearsalService,
    private readonly rehearsalListService: RehearsalListService,
    private readonly analyticsService: RehearsalAnalyticsService,
    private readonly rehearsalReviewService: RehearsalReviewService,
    private readonly settingsService: RehearsalSettingsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new rehearsal',
    description:
      'Creates a new rehearsal session for a scene. The scriptId and projectId are automatically derived from the scene, so only the sceneId needs to be provided. The rehearsal can have a partner that is either another user or an AI. All referenced entities (project, script, scene) must exist and belong to the authenticated user.',
  })
  @ApiBody({
    description: 'Rehearsal creation data',
    type: CreateRehearsalDto,
  })
  @ApiCreatedResponse({
    description: 'Rehearsal created successfully',
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
          description: 'Unique rehearsal identifier',
        },
        userId: {
          type: 'string',
          format: 'uuid',
          example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          description: 'ID of the user who owns this rehearsal',
        },
        projectId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
          description: 'ID of the project this rehearsal belongs to',
        },
        scriptId: {
          type: 'string',
          format: 'uuid',
          example: '223e4567-e89b-12d3-a456-426614174001',
          description: 'ID of the script this rehearsal is for',
        },
        sceneId: {
          type: 'string',
          format: 'uuid',
          example: '323e4567-e89b-12d3-a456-426614174002',
          description: 'ID of the scene being rehearsed',
        },
        rehearsalPartnerType: {
          type: 'string',
          enum: Object.values(RehearsalPartnerType),
          example: RehearsalPartnerType.USER,
          description: 'Type of rehearsal partner (USER or AI)',
        },
        rehearsalPartnerUserId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          description: 'ID of the user partner (when partner type is USER)',
        },
        rehearsalPartnerAiName: {
          type: 'string',
          nullable: true,
          example: 'AI Character Name',
          description: 'Name of the AI partner (when partner type is AI)',
        },
        rehearsalPartnerAiDescription: {
          type: 'string',
          nullable: true,
          example: 'A helpful AI assistant character',
          description:
            'Description of the AI partner (when partner type is AI)',
        },
        rehearsalPartnerAiImage: {
          type: 'string',
          nullable: true,
          example: 'https://example.com/ai-character-avatar.jpg',
          description: 'Image URL for the AI partner (when partner type is AI)',
        },
        project: {
          type: 'object',
          description: 'Project entity',
        },
        script: {
          type: 'object',
          description: 'Script entity',
        },
        scene: {
          type: 'object',
          description: 'Scene entity',
        },
        user: {
          type: 'object',
          description: 'User entity',
        },
        rehearsalPartnerUser: {
          type: 'object',
          nullable: true,
          description: 'User partner entity (when partner type is USER)',
        },
        recordings: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of recordings associated with this rehearsal',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
          description: 'Rehearsal creation timestamp',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
          description: 'Rehearsal last update timestamp',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request data. Common errors: missing required fields, invalid partner configuration, or validation failed.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'string' },
              example: [
                'Scene ID is required',
                'Rehearsal partner user ID is required when partner type is USER',
                'AI partner name is required when partner type is AI',
              ],
            },
            {
              type: 'string',
              example:
                'Scene 323e4567-e89b-12d3-a456-426614174002 does not belong to script 223e4567-e89b-12d3-a456-426614174001',
            },
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
  @ApiForbiddenResponse({
    description:
      'Access denied. User does not have permission to create a rehearsal for the specified project, script, or scene.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example:
            'You are not authorized to create a rehearsal for project 123e4567-e89b-12d3-a456-426614174000',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async createRehearsal(
    @Req() req: any,
    @Body(ValidationPipe) createRehearsalDto: CreateRehearsalDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.createRehearsal(userId, createRehearsalDto);
  }

  @Post('teleprompter')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, FeatureGuard)
  @RequireFeature(Feature.TELEPROMPTER)
  @ApiTags('Rehearsals', 'Teleprompter Solo')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create a SOLO teleprompter rehearsal',
    description:
      'Creates a SOLO-mode rehearsal with the TELEPROMPTER runtime engine. No partner type, no role gating — cue detection is speaker-agnostic. scriptId and projectId are derived from the scene. Optional `characterId` is stored as display-only metadata and does NOT restrict who can read which line. There is no separate prepare step — the WebSocket `session.start` event builds the turn sequence inline.',
  })
  @ApiBody({
    description: 'Teleprompter rehearsal creation payload',
    type: CreateTeleprompterRehearsalDto,
  })
  @ApiCreatedResponse({
    description: 'Teleprompter rehearsal created successfully',
    schema: {
      example: {
        success: true,
        message: 'Teleprompter rehearsal created successfully',
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          userId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          projectId: '123e4567-e89b-12d3-a456-426614174000',
          scriptId: '223e4567-e89b-12d3-a456-426614174001',
          sceneId: '323e4567-e89b-12d3-a456-426614174002',
          characterId: '423e4567-e89b-12d3-a456-426614174003',
          mode: 'SOLO',
          runtimeEngine: 'TELEPROMPTER',
          rehearsalPartnerType: null,
          status: 'CREATED',
          setupState: {
            contentReady: true,
            roleSelectionRequired: false,
            roleSelected: true,
            runtimePrepared: false,
            canPrepareRuntime: false,
            canStartRuntime: true,
            selectedCharacterId: '423e4567-e89b-12d3-a456-426614174003',
            availableCharacterIds: [],
            missingRequirements: [],
          },
          createdAt: '2026-05-22T18:00:00.000Z',
          updatedAt: '2026-05-22T18:00:00.000Z',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      "Invalid request data. Common errors: missing sceneId, malformed UUID, character does not belong to the scene's script.",
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'string' },
              example: [
                'Scene ID is required',
                'Scene ID must be a valid UUID',
              ],
            },
            {
              type: 'string',
              example:
                "Character 423e4567-e89b-12d3-a456-426614174003 does not belong to scene 323e4567-e89b-12d3-a456-426614174002's script",
            },
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
  @ApiForbiddenResponse({
    description:
      'Access denied. User does not own the script referenced by the scene.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example:
            'You are not authorized to create a rehearsal for script 223e4567-e89b-12d3-a456-426614174001',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Scene, script, or character (if provided) not found.',
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
  async createTeleprompterRehearsal(
    @Req() req: any,
    @Body(ValidationPipe) dto: CreateTeleprompterRehearsalDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.createTeleprompter(userId, dto);
  }

  @Get('me/all')
  @ApiOperation({
    summary: 'Get all rehearsals for the authenticated user',
    description:
      'Retrieves all rehearsals associated with the currently authenticated user with pagination, search, sort, and filter capabilities. Supports filtering by partner type, searching by AI partner name/description, and sorting by createdAt or updatedAt.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter rehearsals by AI partner name or description (case-insensitive)',
    example: 'character',
  })
  @ApiQuery({
    name: 'partnerType',
    required: false,
    enum: RehearsalPartnerType,
    description: 'Filter by rehearsal partner type',
    example: RehearsalPartnerType.USER,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: RehearsalSortField,
    description: 'Field to sort by',
    example: RehearsalSortField.CREATED_AT,
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: RehearsalSortOrder,
    description: 'Sort order',
    example: RehearsalSortOrder.DESC,
  })
  @ApiOkResponse({
    description:
      'Paginated list of rehearsals found for the authenticated user',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              projectId: { type: 'string', format: 'uuid' },
              scriptId: { type: 'string', format: 'uuid' },
              sceneId: { type: 'string', format: 'uuid' },
              rehearsalPartnerType: {
                type: 'string',
                enum: Object.values(RehearsalPartnerType),
              },
              rehearsalPartnerUserId: {
                type: 'string',
                format: 'uuid',
                nullable: true,
              },
              rehearsalPartnerAiName: { type: 'string', nullable: true },
              rehearsalPartnerAiDescription: {
                type: 'string',
                nullable: true,
              },
              rehearsalPartnerAiImage: { type: 'string', nullable: true },
              project: { type: 'object' },
              script: { type: 'object' },
              scene: { type: 'object' },
              user: { type: 'object' },
              rehearsalPartnerUser: { type: 'object', nullable: true },
              recordings: { type: 'array', items: { type: 'object' } },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'number', example: 25 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 10 },
        totalPages: { type: 'number', example: 3 },
        hasNext: { type: 'boolean', example: true },
        hasPrev: { type: 'boolean', example: false },
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
          type: 'array',
          items: { type: 'string' },
          example: [
            'page must be a positive integer',
            'limit must not be greater than 100',
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
  async getMyRehearsals(
    @Req() req: any,
    @Query(ValidationPipe) paginationQuery: RehearsalPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.findByUserIdPaginated(userId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      partnerType: paginationQuery.partnerType,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('user/:userId')
  @ApiOperation({
    summary: 'List rehearsals by user ID',
    description:
      'Returns paginated rehearsals for a user. You may only request your own rehearsals (userId must match the authenticated user). Supports search, filters (status, partnerType, projectId, sceneId, date range), and sorting.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search by AI partner name/description, project/script title, scene heading, or partner user',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      'CREATED',
      'PREPARING',
      'READY',
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
    ],
  })
  @ApiQuery({ name: 'partnerType', required: false, enum: ['USER', 'AI'] })
  @ApiQuery({ name: 'projectId', required: false, type: String })
  @ApiQuery({ name: 'sceneId', required: false, type: String })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    type: String,
    description: 'YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    type: String,
    description: 'YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: RehearsalListSortBy,
    description: 'Sort field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: RehearsalListSortOrder,
    description: 'Sort direction',
  })
  @ApiOkResponse({
    description: 'Paginated rehearsals',
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object' } },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
        totalPages: { type: 'number' },
        hasNext: { type: 'boolean' },
        hasPrev: { type: 'boolean' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'You may only list your own rehearsals',
  })
  async listRehearsalsByUserId(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query(ValidationPipe) query: ListRehearsalsByUserIdQueryDto,
  ) {
    const authenticatedUserId = req.user?.id;
    if (!authenticatedUserId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    if (authenticatedUserId !== userId) {
      throw new ForbiddenException(
        'You may only list rehearsals for your own account',
      );
    }
    return this.rehearsalListService.listByUserId(userId, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get rehearsal by ID',
    description:
      'Retrieves a single rehearsal by its unique identifier. Returns the rehearsal with all associated relations (project, script, scene, user, partner user, and recordings).',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Rehearsal found and returned successfully',
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
          description: 'Unique rehearsal identifier',
        },
        userId: {
          type: 'string',
          format: 'uuid',
          example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          description: 'ID of the user who owns this rehearsal',
        },
        projectId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
          description: 'ID of the project this rehearsal belongs to',
        },
        scriptId: {
          type: 'string',
          format: 'uuid',
          example: '223e4567-e89b-12d3-a456-426614174001',
          description: 'ID of the script this rehearsal is for',
        },
        sceneId: {
          type: 'string',
          format: 'uuid',
          example: '323e4567-e89b-12d3-a456-426614174002',
          description: 'ID of the scene being rehearsed',
        },
        rehearsalPartnerType: {
          type: 'string',
          enum: Object.values(RehearsalPartnerType),
          example: RehearsalPartnerType.USER,
          description: 'Type of rehearsal partner',
        },
        rehearsalPartnerUserId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          description: 'ID of the user partner (when partner type is USER)',
        },
        rehearsalPartnerAiName: {
          type: 'string',
          nullable: true,
          example: 'AI Character Name',
          description: 'Name of the AI partner (when partner type is AI)',
        },
        rehearsalPartnerAiDescription: {
          type: 'string',
          nullable: true,
          example: 'A helpful AI assistant character',
          description:
            'Description of the AI partner (when partner type is AI)',
        },
        rehearsalPartnerAiImage: {
          type: 'string',
          nullable: true,
          example: 'https://example.com/ai-character-avatar.jpg',
          description: 'Image URL for the AI partner (when partner type is AI)',
        },
        project: {
          type: 'object',
          description: 'Project entity',
        },
        script: {
          type: 'object',
          description: 'Script entity',
        },
        scene: {
          type: 'object',
          description: 'Scene entity',
        },
        user: {
          type: 'object',
          description: 'User entity',
        },
        rehearsalPartnerUser: {
          type: 'object',
          nullable: true,
          description: 'User partner entity (when partner type is USER)',
        },
        recordings: {
          type: 'array',
          items: { type: 'object' },
          description: 'Array of recordings associated with this rehearsal',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
          description: 'Rehearsal creation timestamp',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
          description: 'Rehearsal last update timestamp',
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
            'Rehearsal with ID 123e4567-e89b-12d3-a456-426614174000 not found',
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
    description:
      'User is not authorized to view this rehearsal (not the owner)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to view this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getRehearsalById(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.findById(id, userId);
  }

  @Get('project/:projectId')
  @ApiOperation({
    summary: 'Get all rehearsals for a project',
    description:
      'Retrieves all rehearsals associated with a specific project with pagination, search, sort, and filter capabilities. Supports filtering by partner type, searching by AI partner name/description, and sorting by createdAt or updatedAt.',
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
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter rehearsals by AI partner name or description (case-insensitive)',
    example: 'character',
  })
  @ApiQuery({
    name: 'partnerType',
    required: false,
    enum: RehearsalPartnerType,
    description: 'Filter by rehearsal partner type',
    example: RehearsalPartnerType.USER,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: RehearsalSortField,
    description: 'Field to sort by',
    example: RehearsalSortField.CREATED_AT,
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: RehearsalSortOrder,
    description: 'Sort order',
    example: RehearsalSortOrder.DESC,
  })
  @ApiOkResponse({
    description: 'Paginated list of rehearsals for the project',
    schema: {
      example: {
        success: true,
        message: 'Rehearsals retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
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
    description:
      'User is not authorized to view rehearsals for this project (not the project owner)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example:
            'You are not authorized to view rehearsals for project 123e4567-e89b-12d3-a456-426614174000',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getRehearsalsByProjectId(
    @Param('projectId') projectId: string,
    @Req() req: any,
    @Query(ValidationPipe) paginationQuery: RehearsalPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.findByProjectIdPaginated(projectId, userId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      partnerType: paginationQuery.partnerType,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('script/:scriptId')
  @ApiOperation({
    summary: 'Get all rehearsals for a script',
    description:
      'Retrieves all rehearsals associated with a specific script with pagination, search, sort, and filter capabilities. Supports filtering by partner type, searching by AI partner name/description, and sorting by createdAt or updatedAt.',
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
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter rehearsals by AI partner name or description (case-insensitive)',
    example: 'character',
  })
  @ApiQuery({
    name: 'partnerType',
    required: false,
    enum: RehearsalPartnerType,
    description: 'Filter by rehearsal partner type',
    example: RehearsalPartnerType.AI,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: RehearsalSortField,
    description: 'Field to sort by',
    example: RehearsalSortField.CREATED_AT,
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: RehearsalSortOrder,
    description: 'Sort order',
    example: RehearsalSortOrder.DESC,
  })
  @ApiOkResponse({
    description: 'Paginated list of rehearsals for the script',
    schema: {
      example: {
        success: true,
        message: 'Rehearsals retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
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
    description:
      'User is not authorized to view rehearsals for this script (not the script owner)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example:
            'You are not authorized to view rehearsals for script 223e4567-e89b-12d3-a456-426614174001',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getRehearsalsByScriptId(
    @Param('scriptId') scriptId: string,
    @Req() req: any,
    @Query(ValidationPipe) paginationQuery: RehearsalPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.findByScriptIdPaginated(scriptId, userId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      partnerType: paginationQuery.partnerType,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('scene/:sceneId')
  @ApiOperation({
    summary: 'Get all rehearsals for a scene',
    description:
      'Retrieves all rehearsals associated with a specific scene with pagination, search, sort, and filter capabilities. Supports filtering by partner type, searching by AI partner name/description, and sorting by createdAt or updatedAt.',
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
    description: 'Page number (1-indexed)',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Number of items per page (1-100)',
    example: 10,
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search term to filter rehearsals by AI partner name or description (case-insensitive)',
    example: 'character',
  })
  @ApiQuery({
    name: 'partnerType',
    required: false,
    enum: RehearsalPartnerType,
    description: 'Filter by rehearsal partner type',
    example: RehearsalPartnerType.AI,
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: RehearsalSortField,
    description: 'Field to sort by',
    example: RehearsalSortField.CREATED_AT,
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: RehearsalSortOrder,
    description: 'Sort order',
    example: RehearsalSortOrder.DESC,
  })
  @ApiOkResponse({
    description: 'Paginated list of rehearsals for the scene',
    schema: {
      example: {
        success: true,
        message: 'Rehearsals retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 10,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
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
    description:
      'User is not authorized to view rehearsals for this scene (not the owner of the parent script)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example:
            'You are not authorized to view rehearsals for scene 323e4567-e89b-12d3-a456-426614174002',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getRehearsalsBySceneId(
    @Param('sceneId') sceneId: string,
    @Req() req: any,
    @Query(ValidationPipe) paginationQuery: RehearsalPaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.findBySceneIdPaginated(sceneId, userId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      partnerType: paginationQuery.partnerType,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update rehearsal',
    description:
      'Updates an existing rehearsal. Only provided fields will be updated. The user must own the rehearsal. When updating partner type, all partner-specific fields are reset accordingly.',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Rehearsal update data',
    type: UpdateRehearsalDto,
  })
  @ApiOkResponse({
    description: 'Rehearsal updated successfully',
    schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
          description: 'Unique rehearsal identifier',
        },
        userId: {
          type: 'string',
          format: 'uuid',
          example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          description: 'ID of the user who owns this rehearsal',
        },
        projectId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
          description: 'ID of the project this rehearsal belongs to',
        },
        scriptId: {
          type: 'string',
          format: 'uuid',
          example: '223e4567-e89b-12d3-a456-426614174001',
          description: 'ID of the script this rehearsal is for',
        },
        sceneId: {
          type: 'string',
          format: 'uuid',
          example: '323e4567-e89b-12d3-a456-426614174002',
          description: 'ID of the scene being rehearsed',
        },
        rehearsalPartnerType: {
          type: 'string',
          enum: Object.values(RehearsalPartnerType),
          example: RehearsalPartnerType.AI,
          description: 'Type of rehearsal partner',
        },
        rehearsalPartnerUserId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: null,
          description: 'ID of the user partner (when partner type is USER)',
        },
        rehearsalPartnerAiName: {
          type: 'string',
          nullable: true,
          example: 'Updated AI Character Name',
          description: 'Name of the AI partner (when partner type is AI)',
        },
        rehearsalPartnerAiDescription: {
          type: 'string',
          nullable: true,
          example: 'Updated AI character description',
          description:
            'Description of the AI partner (when partner type is AI)',
        },
        rehearsalPartnerAiImage: {
          type: 'string',
          nullable: true,
          example: 'https://example.com/updated-ai-avatar.jpg',
          description: 'Image URL for the AI partner (when partner type is AI)',
        },
        project: { type: 'object' },
        script: { type: 'object' },
        scene: { type: 'object' },
        user: { type: 'object' },
        rehearsalPartnerUser: { type: 'object', nullable: true },
        recordings: { type: 'array', items: { type: 'object' } },
        createdAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T11:45:00.000Z',
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
            'Rehearsal with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid update data',
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
  @ApiForbiddenResponse({
    description: 'User is not authorized to update this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to update this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async updateRehearsal(
    @Param('id') id: string,
    @Req() req: any,
    @Body(ValidationPipe) updateRehearsalDto: UpdateRehearsalDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.updateRehearsal(
      id,
      userId,
      updateRehearsalDto,
    );
  }

  @Put(':id/setup')
  @ApiOperation({
    summary: 'Configure rehearsal setup',
    description:
      'Selects the actor character for this rehearsal and returns setup/readiness flags for frontend runtime gating.',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Setup payload',
    type: ConfigureRehearsalSetupDto,
  })
  @ApiOkResponse({
    description: 'Rehearsal setup updated successfully',
  })
  @ApiBadRequestResponse({
    description:
      'The rehearsal has no content yet, runtime preparation is already in progress, or the selected character is not valid for the linked scene.',
  })
  async configureRehearsalSetup(
    @Param('id') id: string,
    @Req() req: any,
    @Body(ValidationPipe) dto: ConfigureRehearsalSetupDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    return this.rehearsalService.configureSetup(id, userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete rehearsal',
    description:
      'Soft deletes a rehearsal. The rehearsal will not be returned in queries but remains in the database. The user must own the rehearsal to delete it.',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiNoContentResponse({
    description: 'Rehearsal soft deleted successfully. No content returned.',
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
            'Rehearsal with ID 123e4567-e89b-12d3-a456-426614174000 not found',
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
    description: 'User is not authorized to delete this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to delete this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async deleteRehearsal(
    @Param('id') id: string,
    @Req() req: any,
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.rehearsalService.deleteRehearsal(id, userId);
  }

  // ── Analytics endpoints (4.3.1 – 4.3.3) ──────────────────────────────────

  @Get(':id/analytics')
  @ApiOperation({
    summary: 'Get rehearsal analytics summary',
    description:
      'Returns a cached (≤1 h) or freshly computed analytics summary for a completed rehearsal. Includes actor line stats, response times, completion percentage, and pause breakdown.',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Analytics summary',
    schema: {
      type: 'object',
      properties: {
        rehearsalId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        computedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
        },
        totalActorLines: { type: 'number', example: 24 },
        linesCompletedFirstAttempt: { type: 'number', example: 18 },
        linesWithRetries: { type: 'number', example: 6 },
        retriesPerLine: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              lineIndex: { type: 'number', example: 5 },
              retryCount: { type: 'number', example: 3 },
            },
          },
        },
        avgResponseTimeMs: { type: 'number', nullable: true, example: 2400 },
        slowestResponseTimeMs: {
          type: 'number',
          nullable: true,
          example: 8200,
        },
        fastestResponseTimeMs: { type: 'number', nullable: true, example: 900 },
        sessionDurationMs: { type: 'number', nullable: true, example: 1800000 },
        activeDurationMs: { type: 'number', nullable: true, example: 1650000 },
        pausedDurationMs: { type: 'number', example: 150000 },
        linesSkipped: { type: 'number', example: 2 },
        completionPct: {
          type: 'number',
          example: 83,
          description: 'Percentage of actor lines completed',
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
          example: 'Rehearsal 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not the owner of this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
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
  async getRehearsalAnalytics(@Param('id') id: string, @Req() req: any) {
    return this.analyticsService.getRehearsalAnalytics(id, req.user?.id);
  }

  @Get(':id/difficult-lines')
  @ApiOperation({
    summary: 'Get top 10 difficult lines for a rehearsal',
    description:
      'Returns the 10 lines the actor struggled with most, sorted by difficulty score. Score = (noMatchAttempts × 2) + (stuckCount × 3) + (driftResetCount × 4) + (quietResetCount × 1) + (avgResponseTimeMs / 1000). Includes the partial transcripts the actor produced before matching. text/characterName are nullable for older rehearsals whose events did not persist them — characterId is still returned for mapping. Check textResolved/characterResolved.',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Top 10 difficult lines sorted by score descending',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lineIndex: { type: 'number', example: 5 },
          text: {
            type: 'string',
            nullable: true,
            example: 'To be or not to be, that is the question',
            description:
              'Script line text. null when the source events did not persist it (older rehearsals). Never an empty string — check textResolved.',
          },
          characterName: {
            type: 'string',
            nullable: true,
            example: 'HAMLET',
            description: 'null when unresolved. Never an empty string.',
          },
          characterId: {
            type: 'string',
            format: 'uuid',
            nullable: true,
            example: '423e4567-e89b-12d3-a456-426614174003',
            description:
              'Character UUID from the event record. Present even when name/text are not — use for character mapping.',
          },
          score: {
            type: 'number',
            example: 9.4,
            description:
              '(noMatchAttempts × 2) + (stuckCount × 3) + (driftResetCount × 4) + (quietResetCount × 1) + (avgResponseTimeMs / 1000)',
          },
          retryCount: {
            type: 'number',
            example: 3,
            description: 'Legacy alias for noMatchAttempts.',
          },
          avgResponseTimeMs: { type: 'number', example: 3400 },
          transcriptAttempts: {
            type: 'array',
            items: { type: 'string' },
            example: ['To be or not to', 'To be or not to be that'],
          },
          noMatchAttempts: { type: 'number', example: 3 },
          stuckCount: { type: 'number', example: 1 },
          driftResetCount: { type: 'number', example: 0 },
          quietResetCount: { type: 'number', example: 1 },
          textResolved: {
            type: 'boolean',
            example: true,
            description:
              'False when text could not be resolved (display a fallback instead of an empty line).',
          },
          characterResolved: {
            type: 'boolean',
            example: true,
            description: 'True when characterId and/or characterName is known.',
          },
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
          example: 'Rehearsal 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not the owner of this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
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
  async getDifficultLines(@Param('id') id: string, @Req() req: any) {
    return this.analyticsService.getDifficultLines(id, req.user?.id);
  }

  @Get(':id/timeline')
  @ApiOperation({
    summary: 'Get full rehearsal event timeline',
    description:
      'Returns all captured events in chronological order. Each entry includes an `offsetMs` field — milliseconds elapsed since session start — so the frontend can render a visual timeline of speaking windows, pauses, retries, and skips.',
  })
  @ApiParam({
    name: 'id',
    description: 'Rehearsal UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description:
      'Ordered array of rehearsal events with session-relative timestamps',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          eventType: {
            type: 'string',
            enum: [
              'line_started',
              'line_completed',
              'line_retried',
              'line_skipped',
              'cue_triggered',
              'pause',
              'resume',
            ],
            example: 'line_completed',
          },
          lineIndex: { type: 'number', nullable: true, example: 3 },
          characterId: {
            type: 'string',
            format: 'uuid',
            nullable: true,
            example: '423e4567-e89b-12d3-a456-426614174003',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            example: '2025-01-15T10:30:45.000Z',
          },
          offsetMs: {
            type: 'number',
            example: 45000,
            description: 'Milliseconds elapsed since session start',
          },
          data: {
            type: 'object',
            nullable: true,
            description:
              'Event-specific payload (e.g. responseTimeMs, transcript, characterName)',
          },
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
          example: 'Rehearsal 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not the owner of this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
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
  async getTimeline(@Param('id') id: string, @Req() req: any) {
    return this.analyticsService.getTimeline(id, req.user?.id);
  }

  // ── Rehearsal Settings ───────────────────────────────────────────────────

  @Get(':id/settings')
  @ApiOperation({
    summary: 'Get effective session settings for a rehearsal',
    description:
      'Resolves rehearsal override → user default → system default. If session is started, returns frozen snapshot. Also returns the persisted voice assignments (characterId → ElevenLabs voiceId) and the list of non-actor characters in the scene, so the settings modal can pre-fill voice dropdowns. Join `voiceMap[characterId]` against `GET /api/hazel/voices` client-side to render voice names/previews.',
  })
  @ApiParam({ name: 'id', description: 'Rehearsal ID (UUID)' })
  @ApiOkResponse({
    description: 'Effective settings returned',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Settings retrieved successfully' },
        data: SETTINGS_DATA_SCHEMA,
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
          example: 'Rehearsal 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to view settings for this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'Not authorized for this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
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
  async getRehearsalSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
  ) {
    const data = await this.settingsService.getEffectiveSettings(
      id,
      req.user?.id,
    );
    return {
      success: true,
      message: 'Settings retrieved successfully',
      data,
    };
  }

  @Put(':id/settings')
  @ApiOperation({
    summary: 'Update per-rehearsal session setting overrides',
    description:
      'Partial update of per-rehearsal overrides. Rejected only while playback is live (status ACTIVE or PAUSED). Edits in CREATED/PREPARING/READY are accepted; any stale frozen snapshot from a prior run is cleared so the next session.start re-freezes with the updated override. Also accepts an optional `voiceMap` (characterId → ElevenLabs voiceId) that is merged into `metaData.voiceMap` — set voice preferences here before calling `POST /session/prepare` so Hazel uses the correct voices from the start without needing the separate voice override endpoint.',
  })
  @ApiParam({ name: 'id', description: 'Rehearsal ID (UUID)' })
  @ApiBody({ type: UpdateRehearsalSettingsDto })
  @ApiOkResponse({
    description:
      'Settings updated successfully. Returns the same shape as GET /:id/settings, including the current `voiceMap`, `voiceMapFrozen` flag, and `characters` list.',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Settings updated successfully' },
        data: SETTINGS_DATA_SCHEMA,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Settings frozen (rehearsal is ACTIVE or PAUSED) or invalid field values',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example:
            'Cannot change settings while rehearsal playback is in progress',
        },
        error: { type: 'string', example: 'Bad Request' },
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
          example: 'Rehearsal 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User is not authorized to modify settings for this rehearsal',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'Not authorized for this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
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
  async updateRehearsalSettings(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: any,
    @Body(ValidationPipe) dto: UpdateRehearsalSettingsDto,
  ) {
    const data = await this.settingsService.updateRehearsalSettings(
      id,
      req.user?.id,
      dto,
    );
    return {
      success: true,
      message: 'Settings updated successfully',
      data,
    };
  }

  // ── Rehearsal Reviews ────────────────────────────────────────────────────

  @Post(':id/review')
  @ApiOperation({
    summary:
      'Submit a review for the other participant in a completed rehearsal',
    description:
      'Response includes an enriched `reviewer` object ({ id, fullName, avatar }) resolved from the auth service, matching the shape returned by `GET /reviews/received`.',
  })
  @ApiParam({ name: 'id', description: 'Rehearsal ID (UUID)' })
  @ApiBody({ type: CreateRehearsalReviewDto })
  @ApiCreatedResponse({
    description: 'Review created and enriched with reviewer profile',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Review created successfully' },
        data: REVIEW_ITEM_SCHEMA,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Rehearsal not found' })
  @ApiBadRequestResponse({
    description: 'Rehearsal not completed or not a user-partnered rehearsal',
  })
  @ApiForbiddenResponse({
    description: 'You were not a participant in this rehearsal',
  })
  async createRehearsalReview(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) rehearsalId: string,
    @Body() dto: CreateRehearsalReviewDto,
  ) {
    return this.rehearsalReviewService.createRehearsalReview(
      rehearsalId,
      req.user.id,
      dto,
    );
  }

  @Patch('reviews/:id')
  @ApiOperation({
    summary: 'Edit a rehearsal review (within 48h window)',
    description:
      'Response includes an enriched `reviewer` object ({ id, fullName, avatar }) resolved from the auth service, matching the shape returned by `GET /reviews/received`.',
  })
  @ApiParam({ name: 'id', description: 'Rehearsal Review ID (UUID)' })
  @ApiBody({ type: UpdateRehearsalReviewDto })
  @ApiOkResponse({
    description: 'Review updated and enriched with reviewer profile',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Review updated successfully' },
        data: REVIEW_ITEM_SCHEMA,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Review not found' })
  @ApiForbiddenResponse({ description: 'Not your review' })
  @ApiBadRequestResponse({
    description: 'Edit window has closed (>48h since creation)',
  })
  async updateRehearsalReview(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRehearsalReviewDto,
  ) {
    return this.rehearsalReviewService.updateRehearsalReview(
      id,
      req.user.id,
      dto,
    );
  }

  @Get('reviews/received')
  @ApiOperation({
    summary:
      'List rehearsal reviews received by the authenticated user (paginated)',
    description:
      'Each item is enriched with a `reviewer` object ({ id, fullName, avatar }) resolved from the auth service. `reviewer` is null if the reviewer account has been deleted. `POST /:id/review` and `PATCH /reviews/:id` return the same enriched shape.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({
    description: 'Paginated list of enriched reviews',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'Reviews retrieved successfully' },
        data: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: REVIEW_ITEM_SCHEMA,
            },
            total: { type: 'number' },
            page: { type: 'number' },
            limit: { type: 'number' },
            totalPages: { type: 'number' },
            hasNext: { type: 'boolean' },
            hasPrev: { type: 'boolean' },
          },
        },
      },
    },
  })
  async listRehearsalReviewsReceived(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.rehearsalReviewService.listReviewsReceived(
      req.user.id,
      page ? Number(page) : 1,
      limit ? Number(limit) : 10,
    );
  }
}
