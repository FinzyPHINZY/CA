/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ValidationPipe,
  UseGuards,
  Req,
  NotFoundException,
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
import { ProjectService } from './project.service';
import { RehearsalAnalyticsService } from '../rehearsal/rehearsal-analytics.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AttachProjectScriptsDto } from './dto/attach-project-scripts.dto';
import { ListProjectOutboxJobsDto } from './dto/list-project-outbox-jobs.dto';
import {
  AttachProjectScriptsResponseDto,
  CreateProjectResponseDto,
  ProjectOutboxJobsResponseDto,
  RetryProjectScriptAnalysisResponseDto,
} from './dto/project-response.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { PasteScriptDto } from './dto/paste-script.dto';
import {
  ListProjectsByUserIdQueryDto,
  ProjectListSortBy,
  ProjectListSortOrder,
} from './dto/list-projects-by-user-query.dto';
import { JwtAuthGuard, ProjectStatus, ScriptRepository } from '@app/common';
import { ProjectListService } from './project-list.service';

@ApiTags('Projects')
@Controller('projects')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class ProjectController {
  constructor(
    private readonly projectService: ProjectService,
    private readonly projectListService: ProjectListService,
    private readonly analyticsService: RehearsalAnalyticsService,
    private readonly scriptRepository: ScriptRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new project',
    description:
      'Creates a new project with metadata only. Scripts can be attached and analyzed later through the project script workflow.',
  })
  @ApiBody({
    description: 'Project creation data',
    type: CreateProjectDto,
  })
  @ApiCreatedResponse({
    description: 'Project created successfully',
    type: CreateProjectResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request data. Common errors: missing required fields or validation failed.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'string' },
              example: ['Title is required'],
            },
            {
              type: 'string',
              example: 'Title must not exceed 255 characters',
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
  async createProject(
    @Req() req: any,
    @Body(ValidationPipe) createProjectDto: CreateProjectDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.projectService.createProject(userId, createProjectDto);
  }

  @Get('me')
  @ApiOperation({
    summary: 'Get paginated projects for the authenticated user',
    description:
      'Retrieves paginated projects for the authenticated user with support for search, filtering, and sorting. Supports filtering by project type, searching by title, and sorting by createdAt, updatedAt, or title in ascending or descending order.',
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
      'Search term to filter projects by title or description (case-insensitive)',
    example: 'my project',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'title'],
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of projects found for the authenticated user',
    schema: {
      example: {
        success: true,
        message: 'Projects retrieved successfully',
        data: {
          items: [
            {
              id: '123e4567-e89b-12d3-a456-426614174000',
              title: 'My Project',
              status: 'ACTIVE',
              analysisState: 'PROCESSING',
              attentionRequired: false,
              totalScripts: 2,
              uploadedScripts: 1,
              processingScripts: 1,
              analyzedScripts: 0,
              failedScripts: 0,
            },
          ],
          total: 1,
          page: 1,
          limit: 10,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
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
  async getMyProjects(
    @Req() req: any,
    @Query(ValidationPipe) query: PaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.projectService.findByUserIdWithPagination(userId, {
      page: query.page,
      limit: query.limit,
      search: query.search,
      status: query.status,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Get('user/:userId')
  @ApiOperation({
    summary: 'List projects by user ID',
    description:
      'Returns paginated projects for a user with full details (scenes, recordings, rehearsals counts, default character name). You may only request your own projects (userId must match the authenticated user). Supports search, filters, and sorting.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by title, description, or default character name',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ProjectStatus,
    description: 'Filter by project status',
  })
  @ApiQuery({ name: 'scenesMin', required: false, type: Number })
  @ApiQuery({ name: 'scenesMax', required: false, type: Number })
  @ApiQuery({ name: 'recordingsMin', required: false, type: Number })
  @ApiQuery({ name: 'recordingsMax', required: false, type: Number })
  @ApiQuery({ name: 'rehearsalsMin', required: false, type: Number })
  @ApiQuery({ name: 'rehearsalsMax', required: false, type: Number })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ProjectListSortBy,
    description: 'Sort field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ProjectListSortOrder,
    description: 'Sort direction',
  })
  @ApiOkResponse({
    description: 'Paginated projects with details',
    schema: {
      example: {
        success: true,
        message: 'Projects retrieved successfully',
        data: {
          items: [
            {
              id: '123e4567-e89b-12d3-a456-426614174000',
              title: 'My Project',
              status: 'ACTIVE',
              analysisState: 'PARTIAL',
              attentionRequired: true,
              totalScripts: 3,
              uploadedScripts: 0,
              processingScripts: 0,
              analyzedScripts: 2,
              failedScripts: 1,
              scenesCount: 12,
              recordingsCount: 4,
              rehearsalsCount: 2,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'You may only list your own projects',
  })
  async listProjectsByUserId(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query(ValidationPipe) query: ListProjectsByUserIdQueryDto,
  ) {
    const authenticatedUserId = req.user?.id;
    if (!authenticatedUserId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    if (authenticatedUserId !== userId) {
      throw new ForbiddenException(
        'You may only list projects for your own account',
      );
    }
    return this.projectListService.listByUserId(userId, query);
  }

  @Get('me/pending/last')
  @ApiOperation({
    summary: 'Get the last pending project for the authenticated user',
    description:
      'Retrieves the most recently created project for the authenticated user that still has queued or processing scripts.',
  })
  @ApiOkResponse({
    description: 'Last pending project found',
    schema: {
      example: {
        success: true,
        message: 'Project retrieved successfully',
        data: { id: 'uuid', title: 'My Project', status: 'ACTIVE' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'No pending project found for the user',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example: 'No pending project found',
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
  async getLastPendingProject(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    const project = await this.projectService.findLastPendingProject(userId);
    if (!project) {
      throw new NotFoundException('No pending project found');
    }
    return {
      success: true,
      message: 'Project retrieved successfully',
      data: project,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get project by ID',
    description:
      'Retrieves a single project by its unique identifier. Returns the project with all associated scripts and rich per-script statistics (scenes, characters, recordings, and rehearsals).',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Project found and returned successfully',
    schema: {
      example: {
        success: true,
        message: 'Project retrieved successfully',
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          userId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          title: 'My New Project',
          status: 'ACTIVE',
          analysisState: 'READY',
          attentionRequired: false,
          totalScripts: 1,
          uploadedScripts: 0,
          processingScripts: 0,
          analyzedScripts: 1,
          failedScripts: 0,
          scripts: [
            {
              id: 'uuid',
              taskId: 'uuid',
              status: 'ANALYZED',
              sceneCount: 42,
              characterCount: 8,
              totalRecordings: 15,
              totalRehersals: 3,
            },
          ],
          totalScenes: 42,
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
      'Access denied. User does not have permission to view this project.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async getProjectById(@Param('id') id: string) {
    return this.projectService.findById(id);
  }

  @Get('script/:scriptId')
  @ApiOperation({
    summary: 'Get paginated projects for a script',
    description:
      'Retrieves paginated projects associated with a specific script ID with support for search, filtering, and sorting. Supports filtering by project type, searching by title, and sorting by createdAt, updatedAt, or title in ascending or descending order.',
  })
  @ApiParam({
    name: 'scriptId',
    description: 'Script unique identifier (UUID)',
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
      'Search term to filter projects by title or description (case-insensitive)',
    example: 'my project',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'title'],
    description: 'Field to sort by',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated list of projects found for the script',
    schema: {
      example: {
        success: true,
        message: 'Projects retrieved successfully',
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
  @ApiBadRequestResponse({
    description: 'Invalid query parameters or script ID format',
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
                'page must be a positive integer',
                'limit must not be greater than 100',
              ],
            },
            {
              type: 'string',
              example: 'Invalid UUID format for scriptId',
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
  async getProjectsByScriptId(
    @Param('scriptId') scriptId: string,
    @Query(ValidationPipe) query: PaginationQueryDto,
  ) {
    return this.projectService.findByScriptIdWithPagination(scriptId, {
      page: query.page,
      limit: query.limit,
      search: query.search,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });
  }

  @Post(':id/scripts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Attach scripts to a project',
    description:
      'Attaches uploaded media files to an existing project as scripts and queues analysis dispatch for each new script. Duplicate media IDs in the request are deduplicated, and media already attached to the project are skipped.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Media IDs to attach to the project',
    type: AttachProjectScriptsDto,
  })
  @ApiCreatedResponse({
    description: 'Scripts attached successfully',
    type: AttachProjectScriptsResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid request data. Common errors: missing media IDs, invalid UUIDs, script limit exceeded, or media ownership mismatch.',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description:
      'Access denied. User does not have permission to modify this project or use one of the provided media files.',
  })
  @ApiNotFoundResponse({
    description: 'Project or media not found',
  })
  async attachScriptsToProject(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) attachProjectScriptsDto: AttachProjectScriptsDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.projectService.attachScriptsToProject(
      userId,
      id,
      attachProjectScriptsDto,
    );
  }

  @Post(':id/scripts/paste')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Paste script text',
    description:
      'Accepts raw script text, uploads it as a .txt file, and queues it for analysis. Useful for pasting sides or audition scripts directly.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
  })
  @ApiBody({
    description: 'Script text to paste',
    type: PasteScriptDto,
  })
  @ApiCreatedResponse({
    description: 'Script pasted and queued for analysis',
  })
  @ApiBadRequestResponse({
    description:
      'Text too short (<200 chars), too long (>500K chars), or project at script limit.',
  })
  @ApiNotFoundResponse({
    description: 'Project not found or not owned by user',
  })
  async pasteScriptToProject(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) pasteScriptDto: PasteScriptDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.projectService.pasteScriptToProject(userId, id, pasteScriptDto);
  }

  @Post(':id/scripts/:scriptId/retry')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Retry failed script analysis',
    description:
      'Queues a new analysis attempt for a failed script that belongs to the specified project. This keeps the same script record, generates a new task ID, and sends the retry through the analysis outbox.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiParam({
    name: 'scriptId',
    description: 'Script unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  @ApiCreatedResponse({
    description: 'Script analysis retry queued successfully',
    type: RetryProjectScriptAnalysisResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Retry is only allowed for failed scripts with a valid source media reference.',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description:
      'Access denied. User does not have permission to retry this script.',
  })
  @ApiNotFoundResponse({
    description: 'Project or script not found',
  })
  async retryProjectScriptAnalysis(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scriptId', ParseUUIDPipe) scriptId: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.projectService.retryProjectScriptAnalysis(userId, id, scriptId);
  }

  @Get(':id/outbox-jobs')
  @ApiOperation({
    summary: 'Inspect project analysis outbox jobs',
    description:
      'Returns debug visibility into analysis outbox jobs for a project owned by the authenticated user. Useful for inspecting failed, pending, or stale dispatch jobs.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'PROCESSING', 'DISPATCHED', 'FAILED'],
    description: 'Optional outbox status filter',
  })
  @ApiQuery({
    name: 'includeDispatched',
    required: false,
    type: Boolean,
    description: 'Include dispatched jobs in the debug response',
    example: false,
  })
  @ApiQuery({
    name: 'onlyStuck',
    required: false,
    type: Boolean,
    description:
      'Only return jobs that look stuck: failed jobs, stale processing jobs, or overdue pending jobs',
    example: true,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of jobs to return',
    example: 20,
  })
  @ApiOkResponse({
    description: 'Project outbox jobs retrieved successfully',
    type: ProjectOutboxJobsResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description:
      'Access denied. User does not have permission to inspect this project.',
  })
  @ApiNotFoundResponse({
    description: 'Project not found',
  })
  async getProjectOutboxJobs(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(ValidationPipe) query: ListProjectOutboxJobsDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    return this.projectService.getProjectOutboxJobs(userId, id, query);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update project',
    description:
      'Updates an existing project. Provided title and/or description values are updated. `newMediaIds` is kept only as a deprecated compatibility path and internally delegates to POST /api/projects/:id/scripts. The user must own the project to update it.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description:
      'Project update data. Title and description can be updated. `newMediaIds` remains temporarily supported as a deprecated compatibility path for attaching scripts.',
    type: UpdateProjectDto,
  })
  @ApiOkResponse({
    description: 'Project updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Project retrieved successfully',
        data: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          title: 'Updated Project Title',
          scripts: [{ id: 'uuid', taskId: 'uuid' }],
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
  @ApiBadRequestResponse({
    description:
      'Invalid update data. Common errors: title exceeds 255 characters, invalid field types, or validation failed.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'string' },
              example: ['Title must not exceed 255 characters'],
            },
            {
              type: 'string',
              example: 'Title must be a string',
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
      'Access denied. User does not have permission to update this project.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async updateProject(
    @Req() req: any,
    @Param('id') id: string,
    @Body(ValidationPipe) updateData: UpdateProjectDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.projectService.updateProject(userId, id, updateData);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete project',
    description:
      'Permanently deletes a project and all associated data. This action cannot be undone. The user must own the project to delete it.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiNoContentResponse({
    description: 'Project deleted successfully. No content returned.',
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
      'Access denied. User does not have permission to delete this project.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  async deleteProject(@Param('id') id: string): Promise<void> {
    return this.projectService.deleteProject(id);
  }

  // analytics endpoints
  @Get(':id/progress')
  @ApiOperation({
    summary: 'Get project rehearsal progress',
    description:
      'Returns project-level analytics across all completed rehearsals: scenes practiced with attempt counts, total rehearsal time, per-scene improvement trend (avg response time over time), characters practiced, last rehearsal date per scene, and current consecutive-day streak. Results are cached in the project record for up to 1 hour.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Project progress summary',
    schema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          format: 'uuid',
          example: '123e4567-e89b-12d3-a456-426614174000',
        },
        computedAt: {
          type: 'string',
          format: 'date-time',
          example: '2025-01-15T10:30:00.000Z',
        },
        scenesPracticed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sceneId: { type: 'string', format: 'uuid' },
              attemptCount: { type: 'number', example: 3 },
              lastRehearsalDate: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
            },
          },
        },
        totalRehearsalTimeMs: { type: 'number', example: 7200000 },
        improvementTrend: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sceneId: { type: 'string', format: 'uuid' },
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rehearsalId: { type: 'string', format: 'uuid' },
                    date: { type: 'string', format: 'date-time' },
                    avgResponseTimeMs: {
                      type: 'number',
                      nullable: true,
                      example: 2400,
                    },
                  },
                },
              },
            },
          },
        },
        charactersPracticed: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
        },
        lastRehearsalDatePerScene: {
          type: 'object',
          additionalProperties: { type: 'string', format: 'date-time' },
        },
        currentStreakDays: { type: 'number', example: 5 },
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
          example: 'Project 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not the owner of this project',
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
  async getProjectProgress(@Param('id') id: string, @Req() req: any) {
    return this.analyticsService.getProjectProgress(id, req.user?.id);
  }

  @Get(':id/scene-comparison')
  @ApiOperation({
    summary: 'Compare scene performance across rehearsal sessions',
    description:
      'For each scene rehearsed more than once, returns per-session metrics: avg response time, retry rate (linesWithRetries / totalActorLines), and completion percentage. Allows the actor to see objective improvement over time. Scenes rehearsed only once are excluded.',
  })
  @ApiParam({
    name: 'id',
    description: 'Project UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Per-scene comparison across sessions',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sceneId: {
            type: 'string',
            format: 'uuid',
            example: '323e4567-e89b-12d3-a456-426614174002',
          },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rehearsalId: { type: 'string', format: 'uuid' },
                date: { type: 'string', format: 'date-time' },
                avgResponseTimeMs: {
                  type: 'number',
                  nullable: true,
                  example: 2400,
                },
                retryRate: { type: 'number', example: 0.25 },
                completionPct: { type: 'number', example: 83 },
              },
            },
          },
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
          example: 'Project 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not the owner of this project',
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
  async getSceneComparison(@Param('id') id: string, @Req() req: any) {
    return this.analyticsService.getSceneComparison(id, req.user?.id);
  }

  @Get(':id/scripts/:scriptId/status')
  @ApiOperation({
    summary: 'Get script analysis status',
    description:
      'Returns the current analysis status and progress for a script. Use this to poll for analysis progress when WebSocket is unavailable.',
  })
  @ApiParam({ name: 'id', description: 'Project UUID', type: 'string' })
  @ApiParam({ name: 'scriptId', description: 'Script UUID', type: 'string' })
  @ApiOkResponse({
    description: 'Script analysis status',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: {
          type: 'string',
          enum: [
            'UPLOADED',
            'PROCESSING',
            'PARSING',
            'ANALYZING',
            'ANALYZED',
            'FAILED',
          ],
        },
        progress: { type: 'number', example: 65 },
        errorMessage: { type: 'string', nullable: true },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  async getScriptStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('scriptId', ParseUUIDPipe) scriptId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    const script = await this.scriptRepository.findById(scriptId);
    if (!script || script.projectId !== id) {
      throw new NotFoundException(
        `Script ${scriptId} not found in project ${id}`,
      );
    }

    return {
      id: script.id,
      status: script.status,
      progress: script.progress ?? 0,
      errorMessage: script.errorMessage ?? null,
      updatedAt: script.updatedAt,
    };
  }
}
