import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import type { AnswerResult } from './answer.service';

const CACHE_PREFIX = 'qa:cache:';

@Injectable()
export class QaCacheService {
  private readonly logger = new Logger(QaCacheService.name);
  private readonly ttl: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.ttl = this.configService.get<number>('SCRIPT_QA_CACHE_TTL', 86400);
  }

  async get(
    scriptId: string,
    question: string,
    contentHash: string,
  ): Promise<AnswerResult | null> {
    const key = this.buildKey(scriptId, question, contentHash);
    const cached = await this.redis.get(key);
    if (!cached) return null;

    try {
      return JSON.parse(cached) as AnswerResult;
    } catch {
      return null;
    }
  }

  async set(
    scriptId: string,
    question: string,
    contentHash: string,
    answer: AnswerResult,
  ): Promise<void> {
    const key = this.buildKey(scriptId, question, contentHash);
    await this.redis.setex(key, this.ttl, JSON.stringify(answer));
  }

  async invalidateForScript(scriptId: string): Promise<void> {
    const pattern = `${CACHE_PREFIX}${scriptId}:*`;
    let cursor = '0';
    let totalDeleted = 0;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.del(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');

    if (totalDeleted > 0) {
      this.logger.log(
        `Invalidated ${totalDeleted} cache entries for script ${scriptId}`,
      );
    }
  }

  private buildKey(
    scriptId: string,
    question: string,
    contentHash: string,
  ): string {
    const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ');
    const hash = createHash('sha256')
      .update(normalized + contentHash)
      .digest('hex')
      .substring(0, 16);
    return `${CACHE_PREFIX}${scriptId}:${hash}`;
  }
}
