import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';
import { QueryClass } from '@app/common';
import type { ScriptMeta } from './retrieval.service';
import { RetrievalService } from './retrieval.service';

const CACHE_PREFIX = 'qa:suggested:';

export interface SuggestedQuestion {
  label: string;
  class: QueryClass;
}

const GENERIC_FALLBACK: SuggestedQuestion[] = [
  { label: 'What is this script about?', class: QueryClass.META },
  { label: 'Who is the protagonist?', class: QueryClass.ANALYTICAL },
  { label: 'How many scenes are there?', class: QueryClass.AGGREGATE },
  { label: 'What are the main themes?', class: QueryClass.META },
  { label: "What's the tone of this script?", class: QueryClass.META },
];

@Injectable()
export class SuggestedQuestionsService {
  private readonly logger = new Logger(SuggestedQuestionsService.name);
  private readonly llm: ChatGoogleGenerativeAI;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: ConfigService,
    private readonly retrievalService: RetrievalService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_GEMINI_API_KEY');
    this.llm = new ChatGoogleGenerativeAI({
      model: 'gemini-2.0-flash',
      apiKey: apiKey || '',
      temperature: 0.4,
      maxOutputTokens: 512,
    });
  }

  async getForScript(scriptId: string): Promise<SuggestedQuestion[]> {
    const cached = await this.redis.get(`${CACHE_PREFIX}${scriptId}`);
    if (cached) {
      try {
        return JSON.parse(cached) as SuggestedQuestion[];
      } catch {
        // regenerate
      }
    }

    const meta = await this.retrievalService.getScriptMeta(scriptId);
    if (!meta) return GENERIC_FALLBACK;

    const generated = await this.generateForScript(meta);
    await this.redis.set(
      `${CACHE_PREFIX}${scriptId}`,
      JSON.stringify(generated),
    );
    return generated;
  }

  async generateForScript(meta: ScriptMeta): Promise<SuggestedQuestion[]> {
    try {
      const genres = meta.genres?.join(', ') || 'unknown';
      const characters =
        typeof meta.characters === 'string'
          ? meta.characters
          : JSON.stringify(meta.characters)?.substring(0, 500) || 'unknown';

      const prompt = `Generate 6 interesting questions a user might ask about a ${genres} screenplay.

Script summary: ${meta.summary || 'N/A'}
Characters: ${characters}
Tone: ${meta.tone || 'N/A'}

Return a JSON array of objects with "label" (the question) and "class" (one of: LOOKUP, AGGREGATE, STRUCTURAL, ANALYTICAL, META).

Include at least:
- 1 META question (about overall script)
- 1 AGGREGATE question (counting/listing)
- 1 ANALYTICAL question (character or theme analysis)
- 1 LOOKUP question (specific scene or line)

Make questions specific to this script's characters and content, not generic.
Return ONLY the JSON array, no other text.`;

      const response = await this.llm.invoke([new HumanMessage(prompt)]);

      const text =
        typeof response.content === 'string'
          ? response.content
          : (response.content as any[]).map((c: any) => c.text ?? '').join('');

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return GENERIC_FALLBACK;

      const parsed = JSON.parse(jsonMatch[0]) as SuggestedQuestion[];
      return parsed
        .filter((q) => q.label && q.class)
        .slice(0, 8)
        .map((q) => ({
          label: q.label,
          class: Object.values(QueryClass).includes(q.class as QueryClass)
            ? (q.class as QueryClass)
            : QueryClass.LOOKUP,
        }));
    } catch (error: any) {
      this.logger.warn(
        `Failed to generate suggested questions: ${error.message}`,
      );
      return GENERIC_FALLBACK;
    }
  }

  async invalidateForScript(scriptId: string): Promise<void> {
    await this.redis.del(`${CACHE_PREFIX}${scriptId}`);
  }
}
