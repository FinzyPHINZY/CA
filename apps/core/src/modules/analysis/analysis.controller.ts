/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AnalysisService } from './analysis.service';
import { StartAnalysisDto } from './dto/start-analysis.dto';

@ApiTags('Analysis')
@Controller('analysis')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Post('start')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start script analysis',
    description:
      'Initiates an AI-powered analysis of a script. Returns a taskId that can be used to track progress via WebSocket and fetch results when complete.',
  })
  @ApiBody({
    type: StartAnalysisDto,
    description: 'Script ID and content to analyze',
  })
  @ApiCreatedResponse({
    description: 'Analysis task started successfully',
    schema: {
      example: {
        success: true,
        message:
          'Analysis started. Connect to WebSocket to receive progress updates.',
        data: {
          taskId: '123e4567-e89b-12d3-a456-426614174000',
          userId: 'user-uuid',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid request data',
    schema: {
      example: {
        success: false,
        message: 'Invalid request data',
        statusCode: 400,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Script not found',
    schema: {
      example: { success: false, message: 'Script not found', statusCode: 404 },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized',
    schema: {
      example: { success: false, message: 'Unauthorized', statusCode: 401 },
    },
  })
  async startAnalysis(
    @Req() req: any,
    @Body() dto: StartAnalysisDto,
  ): Promise<{
    success: boolean;
    message: string;
    data: { taskId: string; userId: string };
  }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    return this.analysisService.startAnalysis(userId, dto);
  }

  @Get(':taskId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get analysis results',
    description:
      'Retrieves the completed analysis results for a given taskId. Returns null if analysis is still in progress or failed. Scene format (including sequential dialogues) is aligned with the Scenes API.',
  })
  @ApiParam({
    name: 'taskId',
    description: 'Task ID returned from the start analysis endpoint',
    type: 'string',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description:
      'Analysis results retrieved successfully. Result.scenes use the same format as the Scenes API: each scene may include dialogues as a sequential array (in script order, one entry per line: { characterId?, characterName, text }).',
    schema: {
      example: {
        success: true,
        message: 'Analysis results retrieved successfully',
        data: {
          taskId: '123e4567-e89b-12d3-a456-426614174000',
          status: 'completed',
          result: {
            summary: 'A compelling drama about...',
            characters: [
              { name: 'John Doe', description: 'A determined protagonist' },
            ],
            scenes: [
              {
                number: 1,
                heading: 'INT. OFFICE - DAY',
                summary: 'John sits at his desk...',
                pages: [1, 2, 3],
                characters: ['John Doe'],
                dialogues: [
                  { characterName: 'John Doe', text: 'Where is the report?' },
                  { characterName: 'Jane', text: 'On your desk.' },
                ],
              },
            ],
            themes: ['determination', 'struggle'],
            confidenceScore: 0.95,
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Analysis task not found',
    schema: {
      example: {
        success: false,
        message: 'Analysis task not found',
        statusCode: 404,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Unauthorized',
    schema: {
      example: { success: false, message: 'Unauthorized', statusCode: 401 },
    },
  })
  async getAnalysisResults(
    @Req() req: any,
    @Param('taskId') taskId: string,
  ): Promise<{ success: boolean; message: string; data: any }> {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }

    return this.analysisService.getAnalysisResults(taskId, userId);
  }
}
