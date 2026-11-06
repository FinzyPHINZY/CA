import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';
import { QueryClass } from '@app/common';
import type { ScriptMetaShort } from './retrieval.service';
import type { TurnPair } from '../prompts/answer-lookup.prompt';
import { buildRouterPrompt } from '../prompts/router.prompt';

export interface RouterResult {
  class: QueryClass;
  rewrittenQuestion: string;
  filters: {
    characters?: string[];
    sceneNumbers?: number[];
    acts?: number[];
  };
  confidence: number;
}

const ROUTER_TIMEOUT_MS = 2000;

const DEFAULT_RESULT: RouterResult = {
  class: QueryClass.LOOKUP,
  rewrittenQuestion: '',
  filters: {},
  confidence: 0.5,
};

@Injectable()
export class QueryRouterService {
  private readonly logger = new Logger(QueryRouterService.name);
  private readonly llm: ChatGoogleGenerativeAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>(
      'GOOGLE_GEMINI_API_KEY',
    );
    const model = this.configService.get<string>(
      'SCRIPT_QA_ROUTER_MODEL',
      'gemini-2.0-flash',
    );

    this.llm = new ChatGoogleGenerativeAI({
      model,
      apiKey,
      temperature: 0,
      maxOutputTokens: 256,
    });
  }

  async classify(
    question: string,
    recentTurns: TurnPair[],
    scriptMeta: ScriptMetaShort,
  ): Promise<RouterResult> {
    try {
      const prompt = buildRouterPrompt({ question, recentTurns, scriptMeta });

      const response = await Promise.race([
        this.llm.invoke([new HumanMessage(prompt)]),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Router timeout')),
            ROUTER_TIMEOUT_MS,
          ),
        ),
      ]);

      const text =
        typeof response.content === 'string'
          ? response.content
          : (response.content as any[]).map((c: any) => c.text ?? '').join('');

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.warn('Router returned no JSON, defaulting to LOOKUP');
        return { ...DEFAULT_RESULT, rewrittenQuestion: question };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const queryClass = this.parseClass(parsed.class);

      return {
        class: queryClass,
        rewrittenQuestion: parsed.rewrittenQuestion || question,
        filters: {
          characters: Array.isArray(parsed.filters?.characters)
            ? parsed.filters.characters
            : undefined,
          sceneNumbers: Array.isArray(parsed.filters?.sceneNumbers)
            ? parsed.filters.sceneNumbers
            : undefined,
          acts: Array.isArray(parsed.filters?.acts)
            ? parsed.filters.acts
            : undefined,
        },
        confidence: typeof parsed.confidence === 'number'
          ? parsed.confidence
          : 0.5,
      };
    } catch (error: any) {
      this.logger.warn(
        `Router failed: ${error.message}, defaulting to LOOKUP`,
      );
      return { ...DEFAULT_RESULT, rewrittenQuestion: question };
    }
  }

  private parseClass(raw: string): QueryClass {
    const upper = (raw || '').toUpperCase().trim();
    if (Object.values(QueryClass).includes(upper as QueryClass)) {
      return upper as QueryClass;
    }
    return QueryClass.LOOKUP;
  }
}
