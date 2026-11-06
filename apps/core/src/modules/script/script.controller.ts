import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { ScriptService } from './script.service';
import {
  JwtAuthGuard,
  Script,
  ScriptStatus,
  PaginationQueryDto,
} from '@app/common';
import { Query, ValidationPipe } from '@nestjs/common';
import { CreateScriptDto } from './dto/create-script.dto';

@ApiTags('Scripts')
@Controller('scripts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class ScriptController {
  constructor(private readonly scriptService: ScriptService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get script by ID with statistics',
    description:
      'Retrieves a specific script by its unique identifier, enriched with comprehensive statistics including scene count, character count, total recordings, and total rehearsals associated with the script.',
  })
  @ApiParam({
    name: 'id',
    description: 'Script unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiOkResponse({
    description: 'Script found with statistics',
    schema: {
      example: {
        success: true,
        message: 'Script retrieved successfully',
        data: {
          id: '223e4567-e89b-12d3-a456-426614174001',
          title: 'Episode 1 - Pilot',
          status: ScriptStatus.ANALYZED,
          sceneCount: 42,
          characterCount: 8,
          totalRecordings: 15,
          totalRehersals: 3,
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
  })
  @ApiForbiddenResponse({
    description: 'You may only view your own scripts',
  })
  async findOne(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.scriptService.findByIdForUser(userId, id);
  }

  @Get('author/:authorId')
  @ApiOperation({
    summary: 'Get scripts by author with statistics',
    description:
      'Retrieves all scripts created by a specific author with pagination, search, sort, and filter capabilities. Each script in the response is enriched with comprehensive statistics including scene count, character count, total recordings, and total rehearsals.',
  })
  @ApiParam({
    name: 'authorId',
    description: 'Author unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
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
    description: 'Search term to filter scripts by title (case-insensitive)',
    example: 'pilot episode',
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
    description:
      'Paginated list of scripts by author, each enriched with statistics',
    schema: {
      example: {
        success: true,
        message: 'Scripts retrieved successfully',
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
    description: 'Author not found or no scripts found for author',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example: 'No scripts found for author',
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
  })
  @ApiForbiddenResponse({
    description: 'You may only list your own scripts',
  })
  async findByAuthor(
    @Req() req: any,
    @Param('authorId', ParseUUIDPipe) authorId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.scriptService.findByAuthorIdPaginatedForUser(userId, authorId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new script',
    description:
      'Creates a standalone script for the authenticated user. This endpoint does not attach the script to a project. To add a script to a project and queue analysis, use the project-scoped endpoint instead.',
  })
  @ApiBody({
    description: 'Script creation data',
    type: CreateScriptDto,
  })
  @ApiCreatedResponse({
    description: 'Script created successfully',
    schema: {
      example: {
        success: true,
        message: 'Script created successfully',
        data: {
          id: '223e4567-e89b-12d3-a456-426614174001',
          title: 'Episode 1 - Pilot',
          status: ScriptStatus.UPLOADED,
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid script data provided',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'array',
          items: { type: 'string' },
          example: ['title should not be empty', 'fileUrl must be a valid URL'],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async create(
    @Req() req: any,
    @Body(ValidationPipe) scriptData: CreateScriptDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.scriptService.createForUser(userId, scriptData);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update script',
    description:
      'Updates an existing script with new data. Only provided fields will be updated; omitted fields remain unchanged. You can update general script fields such as title, status, file URL, and the optional default character (role) reference. This endpoint does not update read-only fields like id, createdAt, or taskId.',
  })
  @ApiParam({
    name: 'id',
    description: 'Script unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiBody({
    description:
      'Updated script data. Only provided fields will be updated. All fields are optional. To set or change a default role, provide defaultCharacterId. To remove a default role, set defaultCharacterId to null.',
    schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Updated script title',
          example: 'Updated Episode 1 - Pilot',
          minLength: 1,
          maxLength: 255,
        },
        status: {
          type: 'string',
          enum: Object.values(ScriptStatus),
          description:
            'Updated script status. Valid values: UPLOADED, PROCESSING, ANALYZED, FAILED',
          example: ScriptStatus.ANALYZED,
        },
        fileUrl: {
          type: 'string',
          format: 'uri',
          description: 'Updated URL or path to the script file',
          example: 'https://storage.example.com/scripts/episode-1-pilot-v2.pdf',
        },
        defaultCharacterId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          description:
            'Optional default role for this script. Must reference an existing character ID belonging to this script. Set to null to remove the default character.',
          example: '333e4567-e89b-12d3-a456-426614174002',
        },
        analysisId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          description:
            'Analysis ID if script has been analyzed. Usually set automatically after AI analysis.',
          example: '444e4567-e89b-12d3-a456-426614174003',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Script updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Script updated successfully',
        data: {
          id: '223e4567-e89b-12d3-a456-426614174001',
          title: 'Updated Episode 1 - Pilot',
          status: ScriptStatus.ANALYZED,
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
  @ApiBadRequestResponse({
    description: 'Invalid script data provided',
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'You may only update your own scripts',
  })
  async update(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() scriptData: Partial<Script>,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.scriptService.updateForUser(userId, id, scriptData);
  }

  @Put(':id/status')
  @ApiOperation({
    summary: 'Update script status',
    description:
      'Updates the status of a script. This is a convenience endpoint specifically for updating only the status field. Valid status values are: UPLOADED (script has been uploaded but not yet processed), PROCESSING (script is currently being analyzed), ANALYZED (script analysis completed successfully), and FAILED (script analysis failed).',
  })
  @ApiParam({
    name: 'id',
    description: 'Script unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiBody({
    description: 'New status value',
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'string',
          enum: Object.values(ScriptStatus),
          description:
            'New script status. Valid values: UPLOADED, PROCESSING, ANALYZED, FAILED',
          example: ScriptStatus.ANALYZED,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Script status updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Script status updated successfully',
        data: {
          id: '223e4567-e89b-12d3-a456-426614174001',
          status: ScriptStatus.ANALYZED,
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
  @ApiBadRequestResponse({
    description: 'Invalid status value or missing status field',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'array',
          items: { type: 'string' },
          example: [
            'status must be one of the following values: UPLOADED, PROCESSING, ANALYZED, FAILED',
            'status should not be empty',
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
    description: 'You may only update your own scripts',
  })
  async updateStatus(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status: ScriptStatus,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.scriptService.updateStatusForUser(userId, id, status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete script',
    description:
      'Permanently deletes a script by its ID. This operation is irreversible and will remove the script and all associated data. Use with caution. If the script is associated with a project, the relationship will be removed, but the project will remain.',
  })
  @ApiParam({
    name: 'id',
    description: 'Script unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiNoContentResponse({
    description: 'Script deleted successfully. No content is returned.',
    schema: {
      type: 'object',
      properties: {},
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
    description: 'Invalid script ID format',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example: 'Validation failed (uuid is expected)',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  @ApiForbiddenResponse({
    description: 'You may only delete your own scripts',
  })
  async delete(@Req() req: any, @Param('id') id: string): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.scriptService.deleteForUser(userId, id);
  }
}
