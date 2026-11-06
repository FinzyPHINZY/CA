/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Get,
  Param,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UpdateTeleprompterPreferencesDto } from './dto/update-teleprompter-preferences.dto';
import { TeleprompterService } from './teleprompter.service';

@ApiTags('Teleprompter')
@Controller('teleprompter')
export class TeleprompterController {
  constructor(private readonly teleprompterService: TeleprompterService) {}

  // get the authenticated user's teleprompter preferences. returns defaults if the user has not saved any preferences.
  @Get('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get teleprompter preferences',
    description:
      "Returns the authenticated user's teleprompter settings, or defaults if none have been saved.",
  })
  @ApiOkResponse({
    description: 'Teleprompter preferences',
    schema: {
      example: {
        success: true,
        message: 'Preferences retrieved successfully',
        data: {
          userId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          defaultScrollSpeed: 150,
          fontSize: 32,
          blackoutMode: false,
          showActionLines: true,
          showParentheticals: true,
          highlightColor: '#FFD700',
        },
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
  async getPreferences(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.teleprompterService.getPreferences(userId);
  }

  // update the authenticated user's teleprompter preferences.
  @Put('preferences')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update teleprompter preferences',
    description:
      "Updates the authenticated user's teleprompter settings. Creates a new record if none exists. Scroll speed must be 50-300 WPM, font size 14-72.",
  })
  @ApiBody({ type: UpdateTeleprompterPreferencesDto })
  @ApiOkResponse({
    description: 'Updated teleprompter preferences',
    schema: {
      example: {
        success: true,
        message: 'Preferences updated successfully',
        data: {
          userId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
          defaultScrollSpeed: 150,
          fontSize: 32,
          blackoutMode: false,
          showActionLines: true,
          showParentheticals: true,
          highlightColor: '#FFD700',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed — scroll speed out of range, font size out of range, etc.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'array',
          items: { type: 'string' },
          example: [
            'scrollSpeed must be between 50 and 300',
            'fontSize must be between 14 and 72',
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
  async updatePreferences(
    @Req() req: any,
    @Body(new ValidationPipe({ whitelist: true }))
    dto: UpdateTeleprompterPreferencesDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.teleprompterService.updatePreferences(userId, dto);
  }

  // get a scene formatted for teleprompter display.
  @Get('scenes/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get scene for teleprompter',
    description:
      "Returns a scene's content formatted for teleprompter display. Each element includes type (dialogue/action/parenthetical), character info, lines, and whether it belongs to the actor's character.",
  })
  @ApiParam({
    name: 'id',
    description: 'Scene UUID',
    type: 'string',
    format: 'uuid',
    example: '323e4567-e89b-12d3-a456-426614174002',
  })
  @ApiQuery({
    name: 'characterId',
    description:
      'The character UUID the actor is playing — actor lines will be highlighted',
    required: true,
    type: 'string',
    example: '423e4567-e89b-12d3-a456-426614174003',
  })
  @ApiOkResponse({
    description: 'Teleprompter-formatted scene content',
    schema: {
      example: {
        success: true,
        message: 'Scene retrieved successfully',
        data: {
          sceneId: '323e4567-e89b-12d3-a456-426614174002',
          sceneNumber: 1,
          heading: 'INT. CASTLE - NIGHT',
          pages: [12],
          elements: [
            {
              type: 'dialogue',
              characterId: '423e4567-e89b-12d3-a456-426614174003',
              characterName: 'HAMLET',
              lines: ['To be or not to be, that is the question'],
              isActor: true,
            },
            {
              type: 'dialogue',
              characterId: '523e4567-e89b-12d3-a456-426614174004',
              characterName: 'HORATIO',
              lines: ['My lord.'],
              isActor: false,
            },
          ],
        },
        metadata: {
          structuralWarnings: [],
          extractionSource: 'adobe_pdf_extract',
          coverageRatio: 0.95,
          parsedPages: [1, 2, 3, 4, 5],
          dualColumnDetected: false,
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
        message: { type: 'string', example: 'Scene not found' },
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
  async getSceneTeleprompter(
    @Param('id') sceneId: string,
    @Query('characterId') characterId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    return this.teleprompterService.getSceneTeleprompter(
      sceneId,
      characterId,
      userId,
    );
  }

  // get all scenes in a script formatted for teleprompter display.
  @Get('scripts/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get script scenes for teleprompter',
    description:
      'Returns all scenes in a script formatted for teleprompter display, ordered by scene number. Allows the frontend to pre-load the entire script for seamless scene transitions.',
  })
  @ApiParam({
    name: 'id',
    description: 'Script UUID',
    type: 'string',
    format: 'uuid',
    example: '223e4567-e89b-12d3-a456-426614174001',
  })
  @ApiQuery({
    name: 'characterId',
    description:
      'The character UUID the actor is playing — actor lines will be highlighted',
    required: true,
    type: 'string',
    example: '423e4567-e89b-12d3-a456-426614174003',
  })
  @ApiOkResponse({
    description:
      'All scenes in the script in teleprompter format, ordered by scene number',
    schema: {
      example: {
        success: true,
        message: 'Script scenes retrieved successfully',
        data: [
          {
            sceneId: '323e4567-e89b-12d3-a456-426614174002',
            sceneNumber: 1,
            heading: 'INT. CASTLE - NIGHT',
            pages: [12],
            elements: [],
          },
          {
            sceneId: '323e4567-e89b-12d3-a456-426614174005',
            sceneNumber: 2,
            heading: 'EXT. BATTLEMENTS - DAWN',
            pages: [13],
            elements: [],
          },
        ],
        metadata: {
          structuralWarnings: ['Possible dual-column layout detected'],
          extractionSource: 'adobe_pdf_extract',
          coverageRatio: 0.9,
          parsedPages: [1, 2, 3, 4, 5],
          dualColumnDetected: true,
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
        message: { type: 'string', example: 'Script not found' },
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
  async getScriptTeleprompterScenes(
    @Param('id') scriptId: string,
    @Query('characterId') characterId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    return this.teleprompterService.getScriptTeleprompterScenes(
      scriptId,
      characterId,
      userId,
    );
  }
}
