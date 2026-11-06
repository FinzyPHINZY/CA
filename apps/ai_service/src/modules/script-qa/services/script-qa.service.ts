import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { QueryClass, RefusalReason } from '@app/common';
import { EmbeddingService } from './embedding.service';
import { RetrievalService } from './retrieval.service';
import { AnswerService, AnswerResult } from './answer.service';
import { QaCacheService } from './qa-cache.service';
import { ConversationService } from './conversation.service';
import { QueryRouterService } from './query-router.service';
import { AggregateService } from './aggregate.service';

const SIMILARITY_FLOOR = 0.3;
const TOP_K_LOOKUP = 10;
const TOP_K_ANALYTICAL = 15;
const TOP_N_ANSWER = 3;

export interface QaAskParams {
  scriptId: string;
  userId: string;
  question: string;
  conversationId?: string;
}

export interface QaResponse {
  messageId: string;
  conversationId: string;
  queryClass: QueryClass;
  answer: string;
  citations: AnswerResult['citations'];
  model: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  cached: boolean;
  refused: boolean;
  refusalReason?: RefusalReason;
}

@Injectable()
export class ScriptQaService {
  private readonly logger = new Logger(ScriptQaService.name);
  private readonly similarityFloor: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly embeddingService: EmbeddingService,
    private readonly retrievalService: RetrievalService,
    private readonly answerService: AnswerService,
    private readonly cacheService: QaCacheService,
    private readonly conversationService: ConversationService,
    private readonly queryRouter: QueryRouterService,
    private readonly aggregateService: AggregateService,
  ) {
    this.similarityFloor = this.configService.get<number>(
      'SCRIPT_QA_SIMILARITY_FLOOR',
      SIMILARITY_FLOOR,
    );
  }

  async ask(params: QaAskParams): Promise<QaResponse> {
    const { scriptId, userId, question } = params;
    const start = Date.now();

    const conversation =
      await this.conversationService.getOrCreateConversation(userId, scriptId);
    const conversationId = conversation.id;

    await this.conversationService.addUserMessage(conversationId, question);

    const contentHash = await this.getScriptContentHash(scriptId);

    const cached = await this.cacheService.get(scriptId, question, contentHash);
    if (cached) {
      const msg = await this.conversationService.addAssistantMessage(
        conversationId,
        cached.answer,
        {
          queryClass: cached.refused ? QueryClass.LOOKUP : QueryClass.META,
          citations: cached.citations,
          model: 'cache',
          latencyMs: Date.now() - start,
        },
      );

      return {
        messageId: msg.id,
        conversationId,
        queryClass: QueryClass.LOOKUP,
        answer: cached.answer,
        citations: cached.citations,
        model: 'cache',
        latencyMs: Date.now() - start,
        tokensIn: 0,
        tokensOut: 0,
        cached: true,
        refused: false,
      };
    }

    if (this.detectPromptInjection(question)) {
      this.logger.warn(`Prompt injection detected from user ${userId}`);
      const refusal = this.answerService.buildRefusal(RefusalReason.OFF_TOPIC);
      const msg = await this.conversationService.addAssistantMessage(
        conversationId,
        refusal.answer,
        { queryClass: QueryClass.OFF_TOPIC, error: 'INJECTION_DETECTED' },
      );
      return {
        messageId: msg.id,
        conversationId,
        queryClass: QueryClass.OFF_TOPIC,
        answer: refusal.answer,
        citations: [],
        model: 'none',
        latencyMs: Date.now() - start,
        tokensIn: 0,
        tokensOut: 0,
        cached: false,
        refused: true,
        refusalReason: RefusalReason.OFF_TOPIC,
      };
    }

    const recentTurns =
      await this.conversationService.getRecentTurns(conversationId);
    const scriptMetaShort =
      await this.retrievalService.getScriptMetaShort(scriptId);

    const routerResult = await this.queryRouter.classify(
      question,
      recentTurns,
      scriptMetaShort,
    );

    const queryClass = routerResult.class;
    const effectiveQuestion = routerResult.rewrittenQuestion;

    this.logger.log(
      `Router: class=${queryClass}, confidence=${routerResult.confidence}, question="${effectiveQuestion.substring(0, 60)}"`,
    );

    let result: AnswerResult;

    try {
      switch (queryClass) {
        case QueryClass.OFF_TOPIC:
          result = this.answerService.buildRefusal(RefusalReason.OFF_TOPIC);
          break;

        case QueryClass.META:
          result = await this.handleMeta(effectiveQuestion, scriptId);
          break;

        case QueryClass.AGGREGATE:
          result = await this.handleAggregate(
            scriptId,
            effectiveQuestion,
            routerResult,
            scriptMetaShort,
            recentTurns,
          );
          break;

        case QueryClass.STRUCTURAL:
          result = await this.handleStructural(
            scriptId,
            effectiveQuestion,
            routerResult,
            scriptMetaShort,
            recentTurns,
          );
          break;

        case QueryClass.ANALYTICAL:
          result = await this.handleAnalytical(
            scriptId,
            effectiveQuestion,
            routerResult,
            scriptMetaShort,
            recentTurns,
          );
          break;

        case QueryClass.LOOKUP:
        default:
          result = await this.handleLookup(
            scriptId,
            effectiveQuestion,
            routerResult,
            scriptMetaShort,
            recentTurns,
          );
          break;
      }
    } catch (error: any) {
      if (error.message === 'CIRCUIT_OPEN' || error.message === 'LLM_TIMEOUT') {
        this.logger.warn(`Gemini unavailable (${error.message}), returning degraded response`);
        result = {
          answer: 'The AI service is temporarily unavailable. Try again in a moment, or ask a counting question (e.g. "how many scenes") which works without AI.',
          citations: [],
          model: 'none',
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          refused: true,
          refusalReason: RefusalReason.LOW_CONFIDENCE,
        };
      } else {
        throw error;
      }
    }

    const msg = await this.conversationService.addAssistantMessage(
      conversationId,
      result.answer,
      {
        queryClass,
        citations: result.citations,
        model: result.model,
        latencyMs: result.latencyMs,
        tokenInput: result.tokensIn,
        tokenOutput: result.tokensOut,
        error: result.refusalReason ?? null,
      },
    );

    if (!result.refused) {
      await this.cacheService.set(scriptId, question, contentHash, result);
    }

    const totalMs = Date.now() - start;

    this.logger.log({
      msg: 'qa_question_completed',
      userId,
      scriptId,
      conversationId,
      messageId: msg.id,
      queryClass,
      routerConfidence: routerResult.confidence,
      model: result.model,
      latencyMs: totalMs,
      answerMs: result.latencyMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cached: false,
      refused: result.refused,
      refusalReason: result.refusalReason ?? null,
    });

    return {
      messageId: msg.id,
      conversationId,
      queryClass,
      answer: result.answer,
      citations: result.citations,
      model: result.model,
      latencyMs: totalMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      cached: false,
      refused: result.refused,
      refusalReason: result.refusalReason,
    };
  }

  private async handleMeta(
    question: string,
    scriptId: string,
  ): Promise<AnswerResult> {
    const meta = await this.retrievalService.getScriptMeta(scriptId);
    if (!meta) {
      return this.answerService.buildRefusal(
        RefusalReason.EMBEDDINGS_NOT_READY,
      );
    }
    return this.answerService.answerMeta(question, meta);
  }

  private async handleAggregate(
    scriptId: string,
    question: string,
    routerResult: any,
    scriptMetaShort: any,
    recentTurns: any[],
  ): Promise<AnswerResult> {
    const template = this.aggregateService.matchTemplate(routerResult);

    if (template) {
      const aggResult = await this.aggregateService.execute(
        scriptId,
        template,
        routerResult,
      );
      return {
        answer: aggResult.answer,
        citations: [],
        model: 'sql',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        refused: false,
      };
    }

    this.logger.debug(
      `No aggregate template matched, falling back to LOOKUP`,
    );
    return this.handleLookup(
      scriptId,
      question,
      routerResult,
      scriptMetaShort,
      recentTurns,
    );
  }

  private async handleStructural(
    scriptId: string,
    question: string,
    routerResult: any,
    scriptMetaShort: any,
    recentTurns: any[],
  ): Promise<AnswerResult> {
    const sceneNumbers = routerResult.filters?.sceneNumbers;

    if (sceneNumbers?.length) {
      const chunks = await this.retrievalService.getChunksByScene(
        scriptId,
        sceneNumbers,
      );
      if (chunks.length) {
        return this.answerService.answerStructural(
          question,
          chunks,
          recentTurns,
          scriptMetaShort,
        );
      }
    }

    return this.handleLookup(
      scriptId,
      question,
      routerResult,
      scriptMetaShort,
      recentTurns,
    );
  }

  private async handleAnalytical(
    scriptId: string,
    question: string,
    routerResult: any,
    scriptMetaShort: any,
    recentTurns: any[],
  ): Promise<AnswerResult> {
    const hasEmbeddings = await this.retrievalService.hasEmbeddings(scriptId);
    const meta = await this.retrievalService.getScriptMeta(scriptId);

    if (!hasEmbeddings || !meta) {
      return this.answerService.buildRefusal(
        RefusalReason.EMBEDDINGS_NOT_READY,
      );
    }

    const queryEmbedding =
      await this.embeddingService.embedQuery(question);
    const chunks = await this.retrievalService.vectorSearch(
      scriptId,
      queryEmbedding,
      TOP_K_ANALYTICAL,
      routerResult.filters,
    );

    if (!chunks.length) {
      return this.answerService.buildRefusal(RefusalReason.LOW_CONFIDENCE);
    }

    return this.answerService.answerAnalytical(
      question,
      chunks.slice(0, 5),
      meta,
      recentTurns,
      scriptMetaShort,
    );
  }

  private async handleLookup(
    scriptId: string,
    question: string,
    routerResult: any,
    scriptMetaShort: any,
    recentTurns: any[],
  ): Promise<AnswerResult> {
    const hasEmbeddings = await this.retrievalService.hasEmbeddings(scriptId);
    if (!hasEmbeddings) {
      return this.answerService.buildRefusal(
        RefusalReason.EMBEDDINGS_NOT_READY,
      );
    }

    const queryEmbedding = await this.embeddingService.embedQuery(question);
    const chunks = await this.retrievalService.vectorSearch(
      scriptId,
      queryEmbedding,
      TOP_K_LOOKUP,
      routerResult.filters,
    );

    if (!chunks.length || chunks[0].similarity < this.similarityFloor) {
      return this.answerService.buildRefusal(RefusalReason.LOW_CONFIDENCE);
    }

    return this.answerService.answerLookup(
      question,
      chunks.slice(0, TOP_N_ANSWER),
      recentTurns,
      scriptMetaShort,
    );
  }

  private detectPromptInjection(question: string): boolean {
    const q = question.toLowerCase();
    const patterns = [
      /ignore\s+(all\s+)?previous\s+(instructions?|prompts?)/,
      /ignore\s+above/,
      /you\s+are\s+now/,
      /new\s+instructions?:/,
      /system\s*:/,
      /assistant\s*:/,
      /\bdo\s+not\s+follow\b.*\brules\b/,
      /reveal\s+(your\s+)?(system\s+)?prompt/,
      /what\s+(?:are|is)\s+your\s+(?:instructions?|system\s+prompt)/,
      /\bDAN\b/,
      /jailbreak/i,
    ];
    return patterns.some((p) => p.test(q));
  }

  private async getScriptContentHash(scriptId: string): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT "contentHash" FROM core_schema.scripts WHERE id = $1 LIMIT 1`,
      [scriptId],
    );
    return rows[0]?.contentHash ?? '';
  }
}
