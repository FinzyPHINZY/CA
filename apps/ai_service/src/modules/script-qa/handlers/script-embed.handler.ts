import { Controller, Injectable, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { ScriptChunk, ScriptEmbedEvent, SCRIPT_QA_EVENTS } from '@app/common';
import { ChunkingService } from '../services/chunking.service';
import { EmbeddingService } from '../services/embedding.service';

const EMBED_LOCK_TTL = 30 * 60;
const EMBED_LOCK_PREFIX = 'qa:embed:lock:';

@Controller()
@Injectable()
export class ScriptEmbedHandler {
  private readonly logger = new Logger(ScriptEmbedHandler.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
  ) {}

  @EventPattern(SCRIPT_QA_EVENTS.SCRIPT_EMBED)
  async handleScriptEmbed(@Payload() data: ScriptEmbedEvent): Promise<void> {
    const { scriptId, contentHash } = data;
    const lockKey = `${EMBED_LOCK_PREFIX}${scriptId}`;
    const start = Date.now();

    this.logger.log(`Embedding job started for script ${scriptId}`);

    const acquired = await this.redis.set(
      lockKey,
      '1',
      'EX',
      EMBED_LOCK_TTL,
      'NX',
    );
    if (!acquired) {
      this.logger.warn(
        `Embedding lock held for script ${scriptId}, skipping`,
      );
      return;
    }

    try {
      if (contentHash) {
        const existing = await this.dataSource
          .getRepository(ScriptChunk)
          .findOne({
            where: { scriptId },
            select: ['contentHash'],
          });

        if (existing?.contentHash === contentHash) {
          this.logger.log(
            `Chunks already exist for script ${scriptId} with matching hash, skipping`,
          );
          return;
        }
      }

      const chunks = await this.chunkingService.chunkScript(scriptId);
      if (!chunks.length) {
        this.logger.warn(`No chunks produced for script ${scriptId}`);
        return;
      }

      const embeddings = await this.embeddingService.embedChunks(chunks);

      const repo = this.dataSource.getRepository(ScriptChunk);

      await this.dataSource.transaction(async (manager) => {
        await manager.delete(ScriptChunk, { scriptId });

        const entities = chunks.map((chunk, i) => {
          const entity = new ScriptChunk();
          entity.scriptId = scriptId;
          entity.sceneId = chunk.sceneId;
          entity.sceneNumber = chunk.sceneNumber;
          entity.chunkIndex = chunk.chunkIndex;
          entity.pageStart = chunk.pageStart;
          entity.pageEnd = chunk.pageEnd;
          entity.characters = chunk.characters.length
            ? chunk.characters
            : null;
          entity.location = chunk.location;
          entity.timeOfDay = chunk.timeOfDay;
          entity.text = chunk.text;
          entity.tokenCount = chunk.tokenCount;
          entity.embedding = embeddings[i];
          entity.contentHash = contentHash ?? '';
          return entity;
        });

        await manager.save(ScriptChunk, entities, { chunk: 50 });
      });

      const elapsed = Date.now() - start;
      this.logger.log(
        `Embedded script ${scriptId}: ${chunks.length} chunks in ${elapsed}ms`,
      );
    } catch (error) {
      const status = error?.status ?? error?.code;
      const retryable =
        status === 429 ||
        (typeof status === 'number' && status >= 500 && status < 600);

      this.logger.error(
        `Embedding failed for script ${scriptId} (status=${status}, retryable=${retryable}): ${error.message}`,
        error.stack,
      );

      if (retryable) {
        throw error;
      }
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
