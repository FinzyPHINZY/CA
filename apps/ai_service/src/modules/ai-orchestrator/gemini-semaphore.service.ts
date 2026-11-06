import * as crypto from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

/**
 * Redis-backed distributed semaphore to limit concurrent Gemini API calls
 * across all ai_service instances.
 *
 * Uses a Redis sorted set where each slot is a member with a TTL-based score.
 * This prevents stale slots from blocking the semaphore if a process dies.
 */
@Injectable()
export class GeminiSemaphoreService implements OnModuleDestroy {
  private readonly logger = new Logger(GeminiSemaphoreService.name);
  private readonly maxConcurrent: number;
  private readonly semaphoreKey = 'gemini:semaphore';
  /** Max time a single slot can be held (ms). Safety net for crashed holders. */
  private readonly slotTtlMs = 15 * 60 * 1000; // 15 minutes
  /** How long to wait for a slot before giving up (ms). */
  private readonly acquireTimeoutMs = 10 * 60 * 1000; // 10 minutes
  /** Polling interval when waiting for a slot (ms). */
  private readonly pollIntervalMs = 2_000;

  /** Track slots acquired by this instance so we can release on shutdown. */
  private readonly heldSlots = new Set<string>();

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: ConfigService,
  ) {
    this.maxConcurrent = this.configService.get<number>(
      'GEMINI_MAX_CONCURRENT',
      3,
    );
    this.logger.log(
      `Gemini semaphore initialized: max ${this.maxConcurrent} concurrent calls`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    // Release all held slots on shutdown
    for (const slotId of this.heldSlots) {
      await this.redis.zrem(this.semaphoreKey, slotId).catch(() => {});
    }
  }

  /**
   * Execute a function while holding a semaphore slot.
   * Ensures the slot is always released, even on error.
   */
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const slotId = await this.acquire();
    try {
      return await fn();
    } finally {
      await this.release(slotId);
    }
  }

  private async acquire(): Promise<string> {
    const slotId = crypto.randomUUID();
    const deadline = Date.now() + this.acquireTimeoutMs;

    while (Date.now() < deadline) {
      // Clean up expired slots first
      await this.redis.zremrangebyscore(
        this.semaphoreKey,
        '-inf',
        Date.now().toString(),
      );

      // Check current slot count
      const currentCount = await this.redis.zcard(this.semaphoreKey);

      if (currentCount < this.maxConcurrent) {
        // Try to claim a slot atomically: add only if count is still below limit
        const score = Date.now() + this.slotTtlMs;
        const added = await this.redis.zadd(
          this.semaphoreKey,
          'NX',
          score.toString(),
          slotId,
        );

        if (added) {
          // Verify we didn't overshoot (race condition with another instance)
          const rank = await this.redis.zrank(this.semaphoreKey, slotId);
          if (rank !== null && rank < this.maxConcurrent) {
            this.heldSlots.add(slotId);
            this.logger.debug(`Semaphore slot acquired: ${slotId}`);
            return slotId;
          }
          // We got a slot but we're over the limit — give it back
          await this.redis.zrem(this.semaphoreKey, slotId);
        }
      }

      // Wait and retry
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new Error(
      `Gemini semaphore acquire timeout after ${this.acquireTimeoutMs / 1000}s — all ${this.maxConcurrent} slots occupied`,
    );
  }

  private async release(slotId: string): Promise<void> {
    await this.redis.zrem(this.semaphoreKey, slotId);
    this.heldSlots.delete(slotId);
    this.logger.debug(`Semaphore slot released: ${slotId}`);
  }
}
