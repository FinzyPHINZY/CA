// buffered batch writer for RehearsalEvent records.
/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
// flushes every 5s or when buffer reaches 10 events.
// on session.end, force-flushes synchronously.

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
export class HazelEventLoggerService implements OnModuleDestroy {
  private readonly logger = new Logger(HazelEventLoggerService.name);
  private readonly buffers = new Map<string, EventBuffer[]>();
  // cached detection mode per session — merged into every event's data payload
  // so analytics can stratify by mode without re-reading settings on each event.
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

  // call once at session start to tag all subsequent events with detection mode.
  setSessionMode(rehearsalId: string, mode: string): void {
    this.modeCache.set(rehearsalId, mode);
  }

  // log an event. auto-flushes when buffer reaches 10.
  async log(
    rehearsalId: string,
    eventType: RehearsalEventType,
    data?: Record<string, any>,
    timestamp: Date = new Date(),
  ): Promise<void> {
    if (!this.buffers.has(rehearsalId)) {
      this.buffers.set(rehearsalId, []);
    }

    // merge cached detection mode into payload — analytics groups by data.mode
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

  // Log a line-scoped event with the line identity (text, characterName,
  // characterId, lineIndex) denormalized from the turn. Use this for every
  // LINE_*/CUE_* event so analytics never has to resolve text/character from
  // volatile external state. `turn` may be null (e.g. skip after teardown) —
  // identity fields fall back to extra then null.
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

  // force-flush all events for a session synchronously (call on session.end).
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
      // put events back at the front to avoid loss
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
