import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

const RATE_PREFIX = 'qa:rate:';
const CONCURRENCY_PREFIX = 'qa:concurrency:';
const QUOTA_PREFIX = 'qa:quota:';
const BURST_PREFIX = 'qa:burst:';
const BURST_WINDOW_PREFIX = 'qa:burst_window:';

@Injectable()
export class QaRateLimitService {
  private readonly ratePerMin: number;
  private readonly maxConcurrency: number;
  private readonly dailyQuota: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.ratePerMin = this.configService.get<number>(
      'SCRIPT_QA_RATE_LIMIT_PER_MIN',
      10,
    );
    this.maxConcurrency = this.configService.get<number>(
      'SCRIPT_QA_CONCURRENCY_PER_USER',
      2,
    );
    this.dailyQuota = this.configService.get<number>(
      'SCRIPT_QA_DAILY_QUOTA',
      500,
    );
  }

  async checkAndIncrement(
    userId: string,
  ): Promise<{ allowed: boolean; reason?: string; retryAfterMs?: number }> {
    const burstKey = `${BURST_PREFIX}${userId}`;
    const blocked = await this.redis.get(burstKey);
    if (blocked) {
      const ttl = await this.redis.ttl(burstKey);
      return { allowed: false, reason: 'RATE_LIMITED', retryAfterMs: ttl * 1000 };
    }

    const concurrencyKey = `${CONCURRENCY_PREFIX}${userId}`;
    const concurrency = await this.redis.get(concurrencyKey);
    if (concurrency && parseInt(concurrency, 10) >= this.maxConcurrency) {
      return { allowed: false, reason: 'RATE_LIMITED', retryAfterMs: 5000 };
    }

    const rateKey = `${RATE_PREFIX}${userId}`;
    const currentRate = await this.redis.get(rateKey);
    if (currentRate && parseInt(currentRate, 10) >= this.ratePerMin) {
      const ttl = await this.redis.ttl(rateKey);
      return {
        allowed: false,
        reason: 'RATE_LIMITED',
        retryAfterMs: ttl * 1000,
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const quotaKey = `${QUOTA_PREFIX}${userId}:${today}`;
    const currentQuota = await this.redis.get(quotaKey);
    if (currentQuota && parseInt(currentQuota, 10) >= this.dailyQuota) {
      return { allowed: false, reason: 'QUOTA_EXCEEDED' };
    }

    const pipeline = this.redis.pipeline();
    pipeline.incr(rateKey);
    pipeline.expire(rateKey, 60);
    pipeline.incr(concurrencyKey);
    pipeline.expire(concurrencyKey, 60);
    pipeline.incr(quotaKey);
    pipeline.expire(quotaKey, 86400);
    await pipeline.exec();

    const burstWindowKey = `${BURST_WINDOW_PREFIX}${userId}`;
    const burstCount = await this.redis.incr(burstWindowKey);
    if (burstCount === 1) {
      await this.redis.expire(burstWindowKey, 60);
    }
    if (burstCount > 20) {
      await this.redis.setex(burstKey, 300, '1');
    }

    return { allowed: true };
  }

  async releaseConcurrency(userId: string): Promise<void> {
    const key = `${CONCURRENCY_PREFIX}${userId}`;
    await this.redis.decr(key);
  }
}
