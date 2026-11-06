import { Controller, Get, Param, Query, ValidationPipe } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
} from '@nestjs/swagger';
import { SceneService } from './scene.service';
import { PaginationQueryDto } from '@app/common';

@ApiTags('Scenes')
@Controller('scenes')
export class SceneController {
  constructor(private readonly sceneService: SceneService) {}

  @Get('script/:scriptId')
  @ApiOperation({
    summary: 'Get scenes by script ID',
    description:
      'Retrieves all unique scenes associated with a specific script with pagination, search, sort, and filter capabilities. Each scene includes the pages where it occurs, the characters that appear in it, and dialogue information. Scenes are returned in ascending order by scene number by default.',
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
      'Search term to filter scenes by heading or summary (case-insensitive)',
    example: 'kitchen',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description:
      'Field to sort by (number, heading, summary, createdAt, updatedAt). Default: number',
    example: 'number',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: ASC',
    example: 'ASC',
  })
  @ApiOkResponse({
    description:
      'Paginated list of unique scenes found for the script. Each scene includes: id, scene number, heading (e.g., "INT. KITCHEN - DAY"), summary, pages (array of page numbers), characters (array with character details), dialogues (sequential, in script order—one entry per line), scriptId, and timestamps.',
    schema: {
      example: {
        success: true,
        message: 'Scenes retrieved successfully',
        data: {
          items: [
            {
              id: '123e4567-e89b-12d3-a456-426614174001',
              scriptId: '123e4567-e89b-12d3-a456-426614174000',
              number: 1,
              heading: 'INT. KITCHEN - GRANVILLE HOTEL - MORNING',
              summary:
                'Late breakfast. Caroline is sitting in the kitchen alone.',
              pages: [1, 2],
              characters: [
                {
                  id: '123e4567-e89b-12d3-a456-426614174002',
                  name: 'CAROLINE',
                  description: 'A determined protagonist',
                },
              ],
              dialogues: [
                {
                  characterId: '123e4567-e89b-12d3-a456-426614174002',
                  characterName: 'CAROLINE',
                  text: 'Hello, how are you?',
                },
                {
                  characterId: '123e4567-e89b-12d3-a456-426614174003',
                  characterName: 'MAY',
                  text: 'I am fine, thank you.',
                },
                {
                  characterId: '123e4567-e89b-12d3-a456-426614174002',
                  characterName: 'CAROLINE',
                  text: 'I am doing okay.',
                },
              ],
              createdAt: '2026-01-23T10:00:00Z',
              updatedAt: '2026-01-23T10:00:00Z',
            },
          ],
          total: 25,
          page: 1,
          limit: 10,
          totalPages: 3,
          hasNext: true,
          hasPrev: false,
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Script not found',
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
  })
  async getScenesByScript(
    @Param('scriptId') scriptId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.sceneService.getScenesByScriptIdPaginated(scriptId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('task/:taskId')
  @ApiOperation({
    summary: 'Get scenes by task ID',
    description:
      'Retrieves all unique scenes associated with a script identified by its task ID. The task ID is used to find the corresponding script, and then all scenes from that script are returned with pagination, search, sort, and filter capabilities. Each scene includes the pages where it occurs, the characters that appear in it, and dialogue information.',
  })
  @ApiParam({
    name: 'taskId',
    description: 'Task unique identifier (UUID) associated with the script',
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
      'Search term to filter scenes by heading or summary (case-insensitive)',
    example: 'kitchen',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description:
      'Field to sort by (number, heading, summary, createdAt, updatedAt). Default: number',
    example: 'number',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: ASC',
    example: 'ASC',
  })
  @ApiOkResponse({
    description:
      'Paginated list of unique scenes found for the script associated with the task.',
    schema: {
      example: {
        success: true,
        message: 'Scenes retrieved successfully',
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
    description: 'Script with the provided taskId not found',
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
  })
  async getScenesByTaskId(
    @Param('taskId') taskId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.sceneService.getScenesByTaskIdPaginated(taskId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get('project/:projectId')
  @ApiOperation({
    summary: 'Get scenes by project ID',
    description:
      'Retrieves all unique scenes from all scripts within a specific project with pagination, search, sort, and filter capabilities. Scenes are deduplicated by scene ID to ensure uniqueness across multiple scripts in the project. Each scene includes the pages where it occurs, the characters that appear in it, and dialogue information.',
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
      'Search term to filter scenes by heading or summary (case-insensitive)',
    example: 'kitchen',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description:
      'Field to sort by (number, heading, summary, createdAt, updatedAt). Default: number',
    example: 'number',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order. Default: ASC',
    example: 'ASC',
  })
  @ApiOkResponse({
    description:
      'Paginated list of unique scenes found across all scripts in the project.',
    schema: {
      example: {
        success: true,
        message: 'Scenes retrieved successfully',
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
    description: 'Project not found or project has no scripts',
  })
  @ApiBadRequestResponse({
    description: 'Invalid query parameters',
  })
  async getScenesByProjectId(
    @Param('projectId') projectId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.sceneService.getScenesByProjectIdPaginated(projectId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get scene by ID',
    description:
      'Retrieves a specific scene by its unique identifier. The response includes complete scene details: scene number, heading, summary, pages (array of page numbers where the scene occurs), characters (array with full character details), dialogues (sequential, in script order—one entry per line), scriptId, and timestamps.',
  })
  @ApiParam({
    name: 'id',
    description: 'Scene unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174001',
  })
  @ApiOkResponse({
    description:
      'Scene details including id, scene number, heading, summary, pages, characters, dialogues, scriptId, and timestamps.',
    schema: {
      example: {
        success: true,
        message: 'Scene retrieved successfully',
        data: {
          id: '123e4567-e89b-12d3-a456-426614174001',
          scriptId: '123e4567-e89b-12d3-a456-426614174000',
          number: 1,
          heading: 'INT. KITCHEN - GRANVILLE HOTEL - MORNING',
          summary:
            'Late breakfast. Caroline is sitting in the kitchen alone, just about to dive into a bowl of hot porridge. May busts in the door, carrying a heavy trunk.',
          pages: [1, 2],
          characters: [
            {
              id: '123e4567-e89b-12d3-a456-426614174002',
              scriptId: '123e4567-e89b-12d3-a456-426614174000',
              name: 'CAROLINE',
              description: 'A determined protagonist',
              background: 'Background information about Caroline',
              definingPersonalityTraits: 'Traits that define Caroline',
              perception: 'How Caroline perceives the world',
              goalAndConflict: "Caroline's goals and conflicts",
              emotionalArc: "Caroline's emotional journey",
              relationships: 'Caroline relationships with other characters',
              subtextAndCoreTruth: 'Subtext and core truth about Caroline',
              createdAt: '2026-01-23T10:00:00Z',
              updatedAt: '2026-01-23T10:00:00Z',
            },
            {
              id: '123e4567-e89b-12d3-a456-426614174003',
              scriptId: '123e4567-e89b-12d3-a456-426614174000',
              name: 'MAY',
              description: 'Supporting character',
              background: null,
              definingPersonalityTraits: null,
              perception: null,
              goalAndConflict: null,
              emotionalArc: null,
              relationships: null,
              subtextAndCoreTruth: null,
              createdAt: '2026-01-23T10:00:00Z',
              updatedAt: '2026-01-23T10:00:00Z',
            },
          ],
          dialogues: [
            {
              characterId: '123e4567-e89b-12d3-a456-426614174002',
              characterName: 'CAROLINE',
              text: 'Hello, how are you?',
            },
            {
              characterId: '123e4567-e89b-12d3-a456-426614174003',
              characterName: 'MAY',
              text: 'I am fine, thank you. How are you doing also?',
            },
            {
              characterId: '123e4567-e89b-12d3-a456-426614174002',
              characterName: 'CAROLINE',
              text: 'I am doing okay, I just dropped the kids at school and I am tired.',
            },
          ],
          createdAt: '2026-01-23T10:00:00Z',
          updatedAt: '2026-01-23T10:00:00Z',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Scene with the provided ID not found',
  })
  @ApiBadRequestResponse({
    description: 'Invalid scene ID format',
  })
  async getSceneById(@Param('id') id: string) {
    return this.sceneService.getSceneById(id);
  }
}
