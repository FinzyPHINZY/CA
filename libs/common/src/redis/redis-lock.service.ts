/** biome-ignore-all lint/style/useImportType: <> */

import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

export interface LockResult {
  acquired: boolean;
  lockToken: string | null;
}

@Injectable()
export class RedisLockService {
  private readonly logger = new Logger(RedisLockService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Acquire a distributed lock on a resource.
   * Uses SET NX EX pattern (atomic set-if-not-exists with expiry).
   *
   * @param resourceKey - The key to lock (e.g., `booking:slot:{slotId}`)
   * @param ttlSeconds - Lock TTL in seconds (default 60)
   * @returns LockResult with acquired status and lock token for release
   */
  async acquireLock(
    resourceKey: string,
    ttlSeconds: number = 60,
  ): Promise<LockResult> {
    const lockToken = randomUUID();
    const lockKey = `lock:${resourceKey}`;

    const result = await this.redis.set(
      lockKey,
      lockToken,
      'EX',
      ttlSeconds,
      'NX',
    );

    if (result === 'OK') {
      this.logger.debug(`Lock acquired: ${lockKey} (TTL: ${ttlSeconds}s)`);
      return { acquired: true, lockToken };
    }

    this.logger.debug(`Lock denied: ${lockKey} (already held)`);
    return { acquired: false, lockToken: null };
  }

  /**
   * Release a lock. Only succeeds if the caller holds the correct token.
   * Uses a Lua script for atomic check-and-delete.
   */
  async releaseLock(resourceKey: string, lockToken: string): Promise<boolean> {
    const lockKey = `lock:${resourceKey}`;

    // Atomic: only delete if the value matches our token
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await this.redis.eval(script, 1, lockKey, lockToken);

    if (result === 1) {
      this.logger.debug(`Lock released: ${lockKey}`);
      return true;
    }

    this.logger.warn(
      `Lock release failed: ${lockKey} (token mismatch or expired)`,
    );
    return false;
  }

  /**
   * Check if a resource is currently locked.
   */
  async isLocked(resourceKey: string): Promise<boolean> {
    const lockKey = `lock:${resourceKey}`;
    const exists = await this.redis.exists(lockKey);
    return exists === 1;
  }

  /**
   * Set a key with TTL (for presence, online status, etc.)
   */
  async setWithTTL(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * Get a key value.
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * Delete a key.
   */
  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Check if key exists.
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  /**
   * Get multiple keys matching a pattern (for batch online status checks).
   * Uses SCAN to avoid blocking Redis.
   */
  async getKeysByPattern(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, matchedKeys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...matchedKeys);
    } while (cursor !== '0');

    return keys;
  }
}
