// Buffered batch writer for RehearsalEvent records produced by the
// teleprompter session. Flushes every 5s or when the buffer reaches 10
// events. On session.end the caller must call `flushSession(rehearsalId)`
// to force-flush before clearing Redis state.
//
// Forked from HazelEventLoggerService so the naming reflects the consumer.
// Both could share an implementation later if we factor up to cue-engine.

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  RehearsalEventRepository,
  RehearsalEventType,
  buildTurnEventData,
  type RehearsalEventData,
  type TurnLike,
} from '@app/common';

interface EventBuffer {
  rehearsalId: string;
  eventType: RehearsalEventType;
  lineIndex?: number;
  characterId?: string;
  data?: Record<string, any>;
  timestamp: Date;
}

const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 10;

@Injectable()
export class TeleprompterEventLoggerService implements OnModuleDestroy {
  private readonly logger = new Logger(TeleprompterEventLoggerService.name);
  private readonly buffers = new Map<string, EventBuffer[]>();
  private readonly modeCache = new Map<string, string>();
  private readonly flushInterval: ReturnType<typeof setInterval>;

  constructor(
    private readonly rehearsalEventRepository: RehearsalEventRepository,
  ) {
    this.flushInterval = setInterval(() => {
      void this.flushAll();
    }, FLUSH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.flushInterval);
  }

  /** Tag all subsequent events with the session's detection mode. */
  setSessionMode(rehearsalId: string, mode: string): void {
    this.modeCache.set(rehearsalId, mode);
  }

  async log(
    rehearsalId: string,
    eventType: RehearsalEventType,
    data?: Record<string, any>,
    timestamp: Date = new Date(),
  ): Promise<void> {
    if (!this.buffers.has(rehearsalId)) {
      this.buffers.set(rehearsalId, []);
    }

    const cachedMode = this.modeCache.get(rehearsalId);
    const mergedData =
      cachedMode && (!data || data.mode === undefined)
        ? { ...(data ?? {}), mode: cachedMode }
        : data;

    const buffer = this.buffers.get(rehearsalId)!;
    buffer.push({
      rehearsalId,
      eventType,
      lineIndex: mergedData?.lineIndex,
      characterId: mergedData?.characterId,
      data: mergedData,
      timestamp,
    });

    if (buffer.length >= FLUSH_BATCH_SIZE) {
      await this.flush(rehearsalId);
    }
  }

  /**
   * Log a line-scoped event with the line identity (text, characterName,
   * characterId, lineIndex) denormalized from the turn. Use for every
   * line/cue event so analytics can read text/character directly off the
   * event. `turn` may be null — identity falls back to extra then null.
   */
  async logTurnEvent(
    rehearsalId: string,
    eventType: RehearsalEventType,
    turn: TurnLike | null | undefined,
    extra: RehearsalEventData = {},
  ): Promise<void> {
    await this.log(
      rehearsalId,
      eventType,
      buildTurnEventData(turn, extra) as Record<string, any>,
    );
  }

  async flushSession(rehearsalId: string): Promise<void> {
    await this.flush(rehearsalId);
    this.buffers.delete(rehearsalId);
    this.modeCache.delete(rehearsalId);
  }

  private async flush(rehearsalId: string): Promise<void> {
    const buffer = this.buffers.get(rehearsalId);
    if (!buffer || buffer.length === 0) return;

    const events = buffer.splice(0, buffer.length);

    try {
      await this.rehearsalEventRepository.createBatch(
        events.map((e) => ({
          rehearsalId: e.rehearsalId,
          eventType: e.eventType,
          lineIndex: e.lineIndex ?? null,
          characterId: e.characterId ?? null,
          data: e.data ?? null,
          timestamp: e.timestamp,
        })),
      );
      this.logger.debug(`Flushed ${events.length} events for ${rehearsalId}`);
    } catch (err: any) {
      this.logger.error(`Flush failed for ${rehearsalId}: ${err.message}`);
      const current = this.buffers.get(rehearsalId) ?? [];
      this.buffers.set(rehearsalId, [...events, ...current]);
    }
  }

  private async flushAll(): Promise<void> {
    for (const [rehearsalId, buffer] of this.buffers.entries()) {
      if (buffer.length > 0) {
        await this.flush(rehearsalId);
      }
    }
  }
}
