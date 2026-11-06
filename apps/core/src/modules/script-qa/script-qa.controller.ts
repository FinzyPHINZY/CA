import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiBadRequestResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  AI_SERVICE,
  JwtAuthGuard,
  FeatureGuard,
  RequireFeature,
  Feature,
  SCRIPT_QA_EVENTS,
  AskQuestionDto,
  FeedbackDto,
  ScriptRepository,
} from '@app/common';
import { QaRateLimitService } from './services/qa-rate-limit.service';

@ApiTags('Script Q&A')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequireFeature(Feature.SCRIPT_QA)
@Controller('api/scripts/:scriptId/qa')
export class ScriptQaController {
  private readonly logger = new Logger(ScriptQaController.name);

  constructor(
    @Inject(AI_SERVICE) private readonly aiClient: ClientProxy,
    private readonly scriptRepository: ScriptRepository,
    private readonly rateLimitService: QaRateLimitService,
  ) {}

  @Post('ask')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask a question about a script',
    description:
      'Submit a natural-language question about a specific script. Returns a grounded answer with scene citations.',
  })
  @ApiParam({ name: 'scriptId', type: 'string', format: 'uuid' })
  @ApiBody({ type: AskQuestionDto })
  @ApiOkResponse({
    description: 'Answer returned successfully',
    schema: {
      example: {
        success: true,
        data: {
          messageId: 'uuid',
          conversationId: 'uuid',
          queryClass: 'LOOKUP',
          answer: 'Sarah first appears in scene 3 [scene 3, p. 4].',
          citations: [
            {
              sceneId: 'uuid',
              sceneNumber: 3,
              pageStart: 4,
              pageEnd: 5,
              snippet: 'INT. KITCHEN...',
            },
          ],
          model: 'gemini-2.0-flash',
          latencyMs: 1820,
          cached: false,
          refused: false,
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid question or parameters' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated' })
  @ApiForbiddenResponse({ description: 'Subscription does not include Script Q&A' })
  @ApiTooManyRequestsResponse({ description: 'Rate limited or quota exceeded' })
  @ApiNotFoundResponse({ description: 'Script not found' })
  async ask(
    @Param('scriptId') scriptId: string,
    @Body() dto: AskQuestionDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;

    await this.validateScriptOwnership(scriptId, userId);

    const rateCheck = await this.rateLimitService.checkAndIncrement(userId);
    if (!rateCheck.allowed) {
      await this.rateLimitService.releaseConcurrency(userId);
      return {
        success: false,
        error: rateCheck.reason,
        retryAfterMs: rateCheck.retryAfterMs,
      };
    }

    try {
      const response = await firstValueFrom(
        this.aiClient
          .send(SCRIPT_QA_EVENTS.QA_ASK, {
            scriptId,
            userId,
            question: dto.question,
            conversationId: dto.conversationId,
          })
          .pipe(timeout(30000)),
      );

      return { success: true, data: response };
    } catch (error) {
      this.logger.error(
        `Q&A failed for script ${scriptId}: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Failed to process question. Please try again.',
      };
    } finally {
      await this.rateLimitService.releaseConcurrency(userId);
    }
  }

  @Get('conversation')
  @ApiOperation({
    summary: 'Get current conversation for this script',
    description:
      'Returns the active conversation and its messages for the authenticated user on this script.',
  })
  @ApiParam({ name: 'scriptId', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation returned' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated' })
  @ApiForbiddenResponse({ description: 'Subscription does not include Script Q&A' })
  async getConversation(
    @Param('scriptId') scriptId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    await this.validateScriptOwnership(scriptId, userId);

    const result = await firstValueFrom(
      this.aiClient
        .send('qa.getConversation', { userId, scriptId })
        .pipe(timeout(10000)),
    );

    return { success: true, data: result };
  }

  @Delete('conversation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear and reset conversation',
    description:
      'Archives the current conversation and creates a fresh one. Previous messages are kept in history.',
  })
  @ApiParam({ name: 'scriptId', type: 'string', format: 'uuid' })
  @ApiOkResponse({ description: 'Conversation archived and reset' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated' })
  @ApiForbiddenResponse({ description: 'Subscription does not include Script Q&A' })
  async clearConversation(
    @Param('scriptId') scriptId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    await this.validateScriptOwnership(scriptId, userId);

    const result = await firstValueFrom(
      this.aiClient
        .send('qa.clearConversation', { userId, scriptId })
        .pipe(timeout(10000)),
    );

    return { success: true, data: result, message: 'Conversation cleared' };
  }

  @Post('messages/:messageId/feedback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit feedback on an answer',
    description: 'Rate an answer as helpful (1), unhelpful (-1), or neutral (0).',
  })
  @ApiParam({ name: 'scriptId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'messageId', type: 'string', format: 'uuid' })
  @ApiBody({ type: FeedbackDto })
  @ApiOkResponse({ description: 'Feedback recorded' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated' })
  @ApiForbiddenResponse({ description: 'Subscription does not include Script Q&A' })
  async submitFeedback(
    @Param('messageId') messageId: string,
    @Body() dto: FeedbackDto,
  ) {
    await firstValueFrom(
      this.aiClient
        .send('qa.feedback', { messageId, score: dto.score })
        .pipe(timeout(10000)),
    );

    return { success: true, message: 'Feedback recorded' };
  }

  @Get('suggested')
  @ApiOperation({
    summary: 'Get suggested questions for this script',
    description:
      'Returns 5-8 pre-computed, genre-aware question suggestions the user can click to ask.',
  })
  @ApiParam({ name: 'scriptId', type: 'string', format: 'uuid' })
  @ApiOkResponse({
    description: 'Suggested questions returned',
    schema: {
      example: {
        success: true,
        data: {
          questions: [
            { label: 'Who is the protagonist?', class: 'ANALYTICAL' },
            { label: 'How many scenes are there?', class: 'AGGREGATE' },
          ],
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated' })
  @ApiForbiddenResponse({ description: 'Subscription does not include Script Q&A' })
  async getSuggestedQuestions(
    @Param('scriptId') scriptId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    await this.validateScriptOwnership(scriptId, userId);

    const questions = await firstValueFrom(
      this.aiClient
        .send('qa.suggestedQuestions', { scriptId })
        .pipe(timeout(15000)),
    );

    return { success: true, data: { questions } };
  }

  private async validateScriptOwnership(
    scriptId: string,
    userId: string,
  ): Promise<void> {
    const script = await this.scriptRepository.findOne({
      where: { id: scriptId },
      withDeleted: false,
    });

    if (!script) {
      throw new NotFoundException('Script not found');
    }

    if (script.userId !== userId) {
      throw new NotFoundException('Script not found');
    }
  }
}
