import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RefusalReason } from '@app/common';
import type { ChunkResult, ScriptMeta, ScriptMetaShort } from './retrieval.service';
import { buildLookupPrompt, TurnPair } from '../prompts/answer-lookup.prompt';
import { buildAnalyticalPrompt } from '../prompts/answer-analytical.prompt';
import { getRefusalMessage } from '../prompts/refusal.prompt';
import { CircuitBreakerService } from './circuit-breaker.service';

const LLM_TIMEOUT_MS = 25000;

export interface Citation {
  sceneId: string | null;
  sceneNumber: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  snippet: string;
}

export interface AnswerResult {
  answer: string;
  citations: Citation[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  refused: boolean;
  refusalReason?: RefusalReason;
}

@Injectable()
export class AnswerService {
  private readonly logger = new Logger(AnswerService.name);
  private readonly llm: ChatGoogleGenerativeAI;
  private readonly proLlm: ChatGoogleGenerativeAI;
  private readonly modelName: string;
  private readonly proModelName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {
    const apiKey = this.configService.getOrThrow<string>(
      'GOOGLE_GEMINI_API_KEY',
    );
    this.modelName = this.configService.get<string>(
      'SCRIPT_QA_ANSWER_MODEL',
      'gemini-2.0-flash',
    );
    this.proModelName = this.configService.get<string>(
      'SCRIPT_QA_ANSWER_MODEL_ANALYTICAL',
      'gemini-2.0-flash',
    );

    const safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_NONE',
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE',
      },
    ] as any;

    this.llm = new ChatGoogleGenerativeAI({
      model: this.modelName,
      apiKey,
      temperature: 0.2,
      maxOutputTokens: 2048,
      safetySettings,
    });

    this.proLlm = new ChatGoogleGenerativeAI({
      model: this.proModelName,
      apiKey,
      temperature: 0.3,
      maxOutputTokens: 4096,
      safetySettings,
    });
  }

  async answerLookup(
    question: string,
    chunks: ChunkResult[],
    recentTurns: TurnPair[],
    scriptMeta: ScriptMetaShort,
  ): Promise<AnswerResult> {
    const start = Date.now();
    const { system, user } = buildLookupPrompt({
      question,
      chunks,
      recentTurns,
      scriptMeta,
    });

    const response = await this.guardedLlmInvoke(
      this.llm,
      [new SystemMessage(system), new HumanMessage(user)],
      this.modelName,
    );

    const answer = typeof response.content === 'string'
      ? response.content
      : (response.content as any[]).map((c: any) => c.text ?? '').join('');

    const citations = this.parseCitations(answer, chunks);

    const usageMeta = response.usage_metadata as any;
    const tokensIn = usageMeta?.input_tokens ?? 0;
    const tokensOut = usageMeta?.output_tokens ?? 0;

    return {
      answer,
      citations,
      model: this.modelName,
      tokensIn,
      tokensOut,
      latencyMs: Date.now() - start,
      refused: false,
    };
  }

  async answerMeta(
    question: string,
    scriptMeta: ScriptMeta,
  ): Promise<AnswerResult> {
    const start = Date.now();

    const directAnswer = this.tryDirectMetaAnswer(question, scriptMeta);
    if (directAnswer) {
      return {
        answer: directAnswer,
        citations: [],
        model: 'cache',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - start,
        refused: false,
      };
    }

    const system = `You answer high-level questions about a screenplay using the provided analysis.
Do not invent details beyond what the analysis contains. Be concise.`;

    const analysisContext = [
      scriptMeta.summary ? `Summary: ${scriptMeta.summary}` : null,
      scriptMeta.genres?.length ? `Genres: ${scriptMeta.genres.join(', ')}` : null,
      scriptMeta.tone ? `Tone: ${scriptMeta.tone}` : null,
      scriptMeta.style ? `Style: ${scriptMeta.style}` : null,
      scriptMeta.structure ? `Structure: ${scriptMeta.structure}` : null,
      scriptMeta.pacing ? `Pacing: ${scriptMeta.pacing}` : null,
      scriptMeta.themes ? `Themes: ${JSON.stringify(scriptMeta.themes)}` : null,
      scriptMeta.dialogue ? `Dialogue: ${scriptMeta.dialogue}` : null,
      scriptMeta.targetAudience
        ? `Target audience: ${scriptMeta.targetAudience}`
        : null,
      scriptMeta.characters
        ? `Characters: ${JSON.stringify(scriptMeta.characters)}`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const user = `Script analysis:\n${analysisContext}\n\nQuestion: ${question}`;

    const response = await this.guardedLlmInvoke(
      this.llm,
      [new SystemMessage(system), new HumanMessage(user)],
      this.modelName,
    );

    const answer = typeof response.content === 'string'
      ? response.content
      : (response.content as any[]).map((c: any) => c.text ?? '').join('');

    const metaUsage = response.usage_metadata as any;
    return {
      answer,
      citations: [],
      model: this.modelName,
      tokensIn: metaUsage?.input_tokens ?? 0,
      tokensOut: metaUsage?.output_tokens ?? 0,
      latencyMs: Date.now() - start,
      refused: false,
    };
  }

  async answerStructural(
    question: string,
    chunks: ChunkResult[],
    recentTurns: TurnPair[],
    scriptMeta: ScriptMetaShort,
  ): Promise<AnswerResult> {
    return this.answerLookup(question, chunks, recentTurns, scriptMeta);
  }

  async answerAnalytical(
    question: string,
    chunks: ChunkResult[],
    cachedAnalysis: ScriptMeta,
    recentTurns: TurnPair[],
    scriptMeta: ScriptMetaShort,
  ): Promise<AnswerResult> {
    const start = Date.now();
    const { system, user } = buildAnalyticalPrompt({
      question,
      chunks,
      cachedAnalysis,
      recentTurns,
      scriptMeta,
    });

    const response = await this.guardedLlmInvoke(
      this.proLlm,
      [new SystemMessage(system), new HumanMessage(user)],
      this.proModelName,
    );

    const answer =
      typeof response.content === 'string'
        ? response.content
        : (response.content as any[]).map((c: any) => c.text ?? '').join('');

    const citations = this.parseCitations(answer, chunks);
    const usageData = response.usage_metadata as any;

    return {
      answer,
      citations,
      model: this.proModelName,
      tokensIn: usageData?.input_tokens ?? 0,
      tokensOut: usageData?.output_tokens ?? 0,
      latencyMs: Date.now() - start,
      refused: false,
    };
  }

  async isGeminiAvailable(): Promise<boolean> {
    return this.circuitBreaker.isAvailable('gemini');
  }

  async guardedLlmInvoke(
    llm: ChatGoogleGenerativeAI,
    messages: any[],
    modelLabel: string,
  ): Promise<any> {
    const available = await this.circuitBreaker.isAvailable('gemini');
    if (!available) {
      throw new Error('CIRCUIT_OPEN');
    }

    try {
      const response = await Promise.race([
        llm.invoke(messages),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('LLM_TIMEOUT')), LLM_TIMEOUT_MS),
        ),
      ]);
      await this.circuitBreaker.recordSuccess('gemini');
      return response;
    } catch (error: any) {
      await this.circuitBreaker.recordFailure('gemini');
      throw error;
    }
  }

  buildRefusal(reason: RefusalReason): AnswerResult {
    return {
      answer: getRefusalMessage(reason),
      citations: [],
      model: 'none',
      tokensIn: 0,
      tokensOut: 0,
      latencyMs: 0,
      refused: true,
      refusalReason: reason,
    };
  }

  private tryDirectMetaAnswer(
    question: string,
    meta: ScriptMeta,
  ): string | null {
    const q = question.toLowerCase().trim();

    if (/\b(genre|genres)\b/.test(q) && meta.genres?.length) {
      return `The genre${meta.genres.length > 1 ? 's are' : ' is'} ${meta.genres.join(', ')}.`;
    }
    if (/\b(tone)\b/.test(q) && meta.tone) {
      return `The tone is ${meta.tone}.`;
    }
    if (/\b(style)\b/.test(q) && meta.style) {
      return `The style is ${meta.style}.`;
    }
    if (/\b(about|summary|synopsis|logline)\b/.test(q) && meta.summary) {
      return meta.summary;
    }
    if (/\b(audience|target)\b/.test(q) && meta.targetAudience) {
      return `The target audience is ${meta.targetAudience}.`;
    }

    return null;
  }

  private parseCitations(
    answer: string,
    chunks: ChunkResult[],
  ): Citation[] {
    const citations: Citation[] = [];
    const seen = new Set<string>();

    // Match [scene N, p. PP] or [scene N, p. PP-PP]
    const regex = /\[scene\s+(\d+),?\s*p\.?\s*(\d+)(?:\s*[-–]\s*(\d+))?\]/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(answer)) !== null) {
      const sceneNum = parseInt(match[1], 10);
      const pageStart = parseInt(match[2], 10);
      const pageEnd = match[3] ? parseInt(match[3], 10) : pageStart;
      const key = `${sceneNum}:${pageStart}`;

      if (seen.has(key)) continue;
      seen.add(key);

      const matchedChunk = chunks.find((c) => c.sceneNumber === sceneNum);

      citations.push({
        sceneId: matchedChunk?.sceneId ?? null,
        sceneNumber: sceneNum,
        pageStart,
        pageEnd,
        snippet: matchedChunk?.text?.substring(0, 200) ?? '',
      });
    }

    return citations;
  }
}
