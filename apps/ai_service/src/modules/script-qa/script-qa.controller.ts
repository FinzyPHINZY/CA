import { Controller, Injectable, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { SCRIPT_QA_EVENTS } from '@app/common';
import { ScriptQaService, QaAskParams } from './services/script-qa.service';
import { RetrievalService } from './services/retrieval.service';
import { ConversationService } from './services/conversation.service';
import { SuggestedQuestionsService } from './services/suggested-questions.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';

@Controller()
@Injectable()
export class ScriptQaInternalController {
  private readonly logger = new Logger(ScriptQaInternalController.name);

  constructor(
    private readonly scriptQaService: ScriptQaService,
    private readonly retrievalService: RetrievalService,
    private readonly conversationService: ConversationService,
    private readonly suggestedQuestionsService: SuggestedQuestionsService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  @MessagePattern(SCRIPT_QA_EVENTS.QA_ASK)
  async handleAsk(@Payload() data: QaAskParams) {
    this.logger.log(
      `Q&A request for script ${data.scriptId}: "${data.question.substring(0, 50)}..."`,
    );
    return this.scriptQaService.ask(data);
  }

  @MessagePattern(SCRIPT_QA_EVENTS.QA_PREPARE)
  async handlePrepare(@Payload() data: { scriptId: string }) {
    const ready = await this.retrievalService.hasEmbeddings(data.scriptId);
    return { ready };
  }

  @MessagePattern('qa.getConversation')
  async handleGetConversation(
    @Payload() data: { userId: string; scriptId: string },
  ) {
    return this.conversationService.getConversationWithMessages(
      data.userId,
      data.scriptId,
    );
  }

  @MessagePattern('qa.clearConversation')
  async handleClearConversation(
    @Payload() data: { userId: string; scriptId: string },
  ) {
    return this.conversationService.archiveAndReset(
      data.userId,
      data.scriptId,
    );
  }

  @MessagePattern('qa.feedback')
  async handleFeedback(
    @Payload() data: { messageId: string; score: number },
  ) {
    await this.conversationService.updateFeedback(data.messageId, data.score);
    return { success: true };
  }

  @MessagePattern('qa.suggestedQuestions')
  async handleSuggestedQuestions(
    @Payload() data: { scriptId: string },
  ) {
    return this.suggestedQuestionsService.getForScript(data.scriptId);
  }

  @MessagePattern('qa.health')
  async handleHealth() {
    const geminiState = await this.circuitBreaker.getState('gemini');
    return {
      gemini: geminiState === 'closed' ? 'ok' : geminiState,
      vectorSearch: 'ok',
      embeddingModel: 'ok',
    };
  }
}
