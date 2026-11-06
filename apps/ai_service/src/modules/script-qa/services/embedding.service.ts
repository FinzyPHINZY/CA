import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import type { ChunkData } from './chunking.service';

const BATCH_SIZE = 100;
const MAX_RETRIES = 1;

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly dims: number;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>(
      'GOOGLE_GEMINI_API_KEY',
    );
    this.model = this.configService.get<string>(
      'SCRIPT_QA_EMBEDDING_MODEL',
      'gemini-embedding-001',
    );
    this.dims = this.configService.get<number>(
      'SCRIPT_QA_EMBEDDING_DIMS',
      768,
    );
    this.client = new GoogleGenAI({ apiKey });
  }

  async embedChunks(chunks: ChunkData[]): Promise<number[][]> {
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      const embeddings = await this.embedBatch(texts);
      allEmbeddings.push(...embeddings);
    }

    return allEmbeddings;
  }

  async embedQuery(query: string): Promise<number[]> {
    const result = await this.callWithRetry([query]);
    return result[0];
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    return this.callWithRetry(texts);
  }

  private async callWithRetry(
    texts: string[],
    attempt = 0,
  ): Promise<number[][]> {
    try {
      const response = await this.client.models.embedContent({
        model: this.model,
        contents: texts,
        config: { outputDimensionality: this.dims },
      });

      if (!response.embeddings || response.embeddings.length !== texts.length) {
        throw new Error(
          `Expected ${texts.length} embeddings, got ${response.embeddings?.length ?? 0}`,
        );
      }

      // Some Gemini SDK versions return values as string[] — coerce to number[].
      return response.embeddings.map((e) =>
        (e.values as Array<number | string>).map((v) => Number(v)),
      );
    } catch (error: any) {
      const status = error?.status ?? error?.code;
      if (attempt < MAX_RETRIES && (status === 429 || status >= 500)) {
        const delay = (attempt + 1) * 1000;
        this.logger.warn(
          `Embedding API error (status ${status}), retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        return this.callWithRetry(texts, attempt + 1);
      }
      throw error;
    }
  }
}
