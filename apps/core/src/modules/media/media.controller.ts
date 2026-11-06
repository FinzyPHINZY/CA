import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { MediaService } from './media.service';
import { Media } from './entities/media.entity';
import { PaginationQueryDto } from '@app/common';

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get media by ID',
    description: 'Retrieves a specific media file by its unique identifier',
  })
  @ApiParam({
    name: 'id',
    description: 'Media unique identifier',
    type: 'string',
  })
  @ApiOkResponse({
    description: 'Media found',
    schema: {
      example: {
        success: true,
        message: 'Media retrieved successfully',
        data: { id: 'uuid', url: '...', type: 'video' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Media not found' })
  async findOne(@Param('id') id: string) {
    return this.mediaService.findById(id);
  }

  @Get('owner/:ownerId')
  @ApiOperation({
    summary: 'Get media by owner',
    description:
      'Retrieves all media files owned by a specific user with pagination, search, sort, and filter capabilities.',
  })
  @ApiParam({
    name: 'ownerId',
    description: 'Owner unique identifier',
    type: 'string',
  })
  @ApiOkResponse({
    description: 'Paginated list of media files owned by user',
    schema: {
      example: {
        success: true,
        message: 'Media retrieved successfully',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 20,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      },
    },
  })
  async findByOwner(
    @Param('ownerId') ownerId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ) {
    return this.mediaService.findByUserIdPaginated(ownerId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }

  // @Post()
  // @HttpCode(HttpStatus.CREATED)
  // @ApiOperation({
  //   summary: 'Create media record',
  //   description: 'Creates a new media file record in the system',
  // })
  // @ApiBody({ description: 'Media data', type: Object })
  // @ApiCreatedResponse({ description: 'Media created successfully', type: Object })
  // @ApiBadRequestResponse({ description: 'Invalid media data provided' })
  // async create(@Body() mediaData: Partial<Media>): Promise<Media> {
  //   return this.mediaService.create(mediaData);
  // }

  @Put(':id')
  @ApiOperation({
    summary: 'Update media',
    description: 'Updates an existing media file record',
  })
  @ApiParam({
    name: 'id',
    description: 'Media unique identifier',
    type: 'string',
  })
  @ApiBody({ description: 'Updated media data', type: Object })
  @ApiOkResponse({
    description: 'Media updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Media updated successfully',
        data: { id: 'uuid', url: '...', type: 'video' },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Media not found' })
  @ApiBadRequestResponse({ description: 'Invalid media data provided' })
  async update(@Param('id') id: string, @Body() mediaData: Partial<Media>) {
    return this.mediaService.update(id, mediaData);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete media',
    description: 'Permanently deletes a media file record',
  })
  @ApiParam({
    name: 'id',
    description: 'Media unique identifier',
    type: 'string',
  })
  @ApiNoContentResponse({ description: 'Media deleted successfully' })
  @ApiNotFoundResponse({ description: 'Media not found' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.mediaService.delete(id);
  }
}
