import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { RehearsalStatus } from '@app/common';
import { HazelSessionService } from '../hazel/hazel-session.service';
import { TeleprompterSessionService } from '../teleprompter/teleprompter-session.service';

@Injectable()
export class StaleSessionReaperService {
  private readonly logger = new Logger(StaleSessionReaperService.name);
  private readonly graceMs: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly configService: ConfigService,
    private readonly hazelSessionService: HazelSessionService,
    private readonly teleprompterSessionService: TeleprompterSessionService,
  ) {
    const graceSeconds = this.configService.get<number>(
      'HAZEL_DISCONNECT_GRACE_SECONDS',
      300,
    );
    this.graceMs = graceSeconds * 1000;
  }

  @Cron('*/60 * * * * *')
  async reapStaleSessions(): Promise<void> {
    const now = Date.now();
    let reaped = 0;

    reaped += await this.reapByPattern('hazel:*:state', now, 'hazel');
    reaped += await this.reapByPattern('tp:*:state', now, 'teleprompter');

    if (reaped > 0) {
      this.logger.log(`Reaped ${reaped} stale session(s)`);
    }
  }

  private async reapByPattern(
    pattern: string,
    now: number,
    engine: 'hazel' | 'teleprompter',
  ): Promise<number> {
    const keys = await this.scanKeys(pattern);
    let count = 0;

    for (const key of keys) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;

        const state = JSON.parse(raw);
        if (
          (state.status !== 'active' && state.status !== 'paused') ||
          !state.lastSocketDisconnectAt
        ) {
          continue;
        }

        const disconnectedAt = new Date(
          state.lastSocketDisconnectAt,
        ).getTime();
        if (now - disconnectedAt < this.graceMs) continue;

        const { rehearsalId, userId } = state;

        if (engine === 'hazel') {
          await this.hazelSessionService.forceResetSession(
            rehearsalId,
            userId,
            RehearsalStatus.CANCELLED,
            { reason: 'stale_session_reaper' },
          );
        } else {
          await this.teleprompterSessionService.forceReset(
            rehearsalId,
            userId,
          );
        }

        count++;
        this.logger.warn(
          `Reaped stale ${engine} session: ${rehearsalId} (disconnected ${Math.round((now - disconnectedAt) / 1000)}s ago)`,
        );
      } catch (err: any) {
        this.logger.error(
          `Failed to reap session from key ${key}: ${err.message}`,
        );
      }
    }

    return count;
  }

  private async scanKeys(pattern: string): Promise<string[]> {
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
