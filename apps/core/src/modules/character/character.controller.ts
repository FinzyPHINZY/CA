import { Controller, Get, Param, Query, ValidationPipe } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { CharacterService } from './character.service';
import {
  Character,
  PaginationQueryDto,
  PaginatedResponseDto,
} from '@app/common';

@ApiTags('Characters')
@ApiExtraModels(Character, PaginatedResponseDto)
@Controller('characters')
export class CharacterController {
  constructor(private readonly characterService: CharacterService) {}

  @Get('script/:scriptId')
  @ApiOperation({
    summary: 'Get characters by script',
    description:
      'Retrieves all characters associated with a specific script with pagination, search, sort, and filter capabilities.',
  })
  @ApiParam({
    name: 'scriptId',
    description: 'Script unique identifier',
    type: 'string',
  })
  @ApiOkResponse({
    description: 'Paginated list of characters found for the script',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponseDto) },
        {
          properties: {
            data: {
              type: 'array',
              items: { $ref: getSchemaPath(Character) },
            },
          },
        },
      ],
    },
  })
  @ApiNotFoundResponse({ description: 'Script not found' })
  async getCharactersByScript(
    @Param('scriptId') scriptId: string,
    @Query(ValidationPipe) paginationQuery: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<Character>> {
    return this.characterService.getCharactersByScriptIdPaginated(scriptId, {
      page: paginationQuery.page,
      limit: paginationQuery.limit,
      search: paginationQuery.search,
      sortBy: paginationQuery.sortBy,
      sortOrder: paginationQuery.sortOrder,
    });
  }
}
