// TeleprompterSessionService — manages Redis session state + Rehersal DB
// lifecycle transitions for teleprompter sessions.
//
// Redis keys (4h TTL): tp:{rehearsalId}:state, tp:{rehearsalId}:sequence,
//                      tp:{rehearsalId}:cursor:* (managed by CursorStateService)
//
// No lock service (solo sessions; one user, one rehearsal — concurrency is
// enforced by Redis state existence). No settings-freeze indirection — the
// FE passes detectionMode/silencePace on `session.start` and they're frozen
// into Redis state for the session lifetime.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  RehearsalEventType,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Rehersal,
  RehersalRepository,
  assertValidTransition,
} from '@app/common';
import { TeleprompterEventLoggerService } from './teleprompter-event-logger.service';
import type {
  TeleprompterSessionState,
  TeleprompterSettings,
  TeleprompterTurnKind,
} from './types/teleprompter.types';

const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

const DEFAULT_SETTINGS: TeleprompterSettings = {
  detectionMode: 'AUTO',
  silencePace: 'normal',
  autoAdvanceOnSilence: true,
  includeActions: false,
};

@Injectable()
export class TeleprompterSessionService {
  private readonly logger = new Logger(TeleprompterSessionService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly rehersalRepository: RehersalRepository,
    private readonly eventLogger: TeleprompterEventLoggerService,
  ) {}

  private stateKey(rehearsalId: string) {
    return `tp:${rehearsalId}:state`;
  }

  // Redis state CRUD

  async createInitialState(
    userId: string,
    rehearsalId: string,
    sceneId: string,
    settings: Partial<TeleprompterSettings> = {},
  ): Promise<TeleprompterSessionState> {
    const state: TeleprompterSessionState = {
      userId,
      rehearsalId,
      sceneId,
      status: 'preparing',
      currentLineIndex: 0,
      currentTurn: 'line',
      totalLines: 0,
      totalPausedMs: 0,
      pausedAt: null,
      startedAt: new Date().toISOString(),
      committedTranscript: '',
      accumulatedTranscript: '',
      fragmentTranscript: '',
      lineMismatchCount: 0,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      lastEmittedKeywords: null,
      deepgramKeyId: null,
      lastSocketDisconnectAt: null,
    };
    await this.redis.set(
      this.stateKey(rehearsalId),
      JSON.stringify(state),
      'EX',
      SESSION_TTL_SECONDS,
    );
    this.logger.log(`Teleprompter session created: ${rehearsalId}`);
    return state;
  }

  async getSession(rehearsalId: string): Promise<TeleprompterSessionState> {
    const raw = await this.redis.get(this.stateKey(rehearsalId));
    if (!raw) {
      throw new NotFoundException(
        `Teleprompter session not found: ${rehearsalId}`,
      );
    }
    return JSON.parse(raw) as TeleprompterSessionState;
  }

  async updateSession(
    rehearsalId: string,
    patch: Partial<TeleprompterSessionState>,
  ): Promise<TeleprompterSessionState> {
    const current = await this.getSession(rehearsalId);
    const updated = { ...current, ...patch };
    await this.redis.set(
      this.stateKey(rehearsalId),
      JSON.stringify(updated),
      'EX',
      SESSION_TTL_SECONDS,
    );
    return updated;
  }

  async sessionExists(rehearsalId: string): Promise<boolean> {
    const exists = await this.redis.exists(this.stateKey(rehearsalId));
    return exists === 1;
  }

  /**
   * Look up the underlying Rehersal row for a teleprompter session.
   * Returns null if the rehearsal is missing or doesn't belong to `userId`.
   * Used by the gateway to validate ownership + resolve sceneId at
   * `session.start` before creating Redis state.
   */
  async getOwnedRehearsal(
    rehearsalId: string,
    userId: string,
  ): Promise<Rehersal | null> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal || rehearsal.userId !== userId) {
      return null;
    }
    return rehearsal;
  }

  async setCurrentTurn(
    rehearsalId: string,
    kind: TeleprompterTurnKind,
    lineIndex: number,
  ): Promise<void> {
    // Atomic — reset transcript buffer + mismatch counter alongside the turn
    // change so a transcript landing right after advance can't contaminate
    // the new turn with stale fragments from the old one.
    await this.updateSession(rehearsalId, {
      currentTurn: kind,
      currentLineIndex: lineIndex,
      committedTranscript: '',
      accumulatedTranscript: '',
      fragmentTranscript: '',
      lineMismatchCount: 0,
    });
  }

  /** Append a transcript fragment to the session buffer. */
  async recordTranscript(
    rehearsalId: string,
    transcript: string,
    isInterim: boolean,
  ): Promise<{ accumulatedTranscript: string; fragmentTranscript: string }> {
    const current = await this.getSession(rehearsalId);
    // Interim transcripts REPLACE the live view (committed baseline + this
    // interim) without mutating the baseline — so cumulative Deepgram interims
    // ("we", "we were", "we were just"…) don't bloat the buffer. Finals append
    // to the committed baseline and become the new replay floor.
    const newCommitted = isInterim
      ? current.committedTranscript
      : `${current.committedTranscript} ${transcript}`.trim();
    const accumulated = isInterim
      ? `${newCommitted} ${transcript}`.trim()
      : newCommitted;
    const patch: Partial<TeleprompterSessionState> = {
      accumulatedTranscript: accumulated,
      fragmentTranscript: transcript,
    };
    if (!isInterim) {
      patch.committedTranscript = newCommitted;
    }
    await this.updateSession(rehearsalId, patch);
    return {
      accumulatedTranscript: accumulated,
      fragmentTranscript: transcript,
    };
  }

  async clearTranscriptBuffer(rehearsalId: string): Promise<void> {
    await this.updateSession(rehearsalId, {
      committedTranscript: '',
      accumulatedTranscript: '',
      fragmentTranscript: '',
    });
  }

  async registerMismatch(
    rehearsalId: string,
    transcript: string,
  ): Promise<{ lineMismatchCount: number }> {
    const current = await this.getSession(rehearsalId);
    const next = current.lineMismatchCount + 1;
    await this.updateSession(rehearsalId, {
      lineMismatchCount: next,
      fragmentTranscript: transcript,
    });
    return { lineMismatchCount: next };
  }

  // Lifecycle: Rehersal DB status transitions mirror HazelSessionService.mark*
  // pattern. The Redis status and the Postgres status must move together.

  async markActive(rehearsalId: string): Promise<void> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      this.logger.warn(
        `Unable to mark missing rehearsal as ACTIVE: ${rehearsalId}`,
      );
      return;
    }
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.ACTIVE,
      runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
      startedAt: rehearsal.startedAt ?? new Date(),
      endedAt: null,
    });
    if (rehearsal.status !== RehearsalStatus.ACTIVE) {
      await this.eventLogger.log(
        rehearsalId,
        RehearsalEventType.SESSION_STARTED,
        {
          runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
          characterId: rehearsal.characterId ?? undefined,
        },
      );
    }
  }

  async markPaused(rehearsalId: string): Promise<void> {
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.PAUSED,
      runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
    });
  }

  async markResumed(rehearsalId: string): Promise<void> {
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.ACTIVE,
      runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
    });
  }

  async markCompleted(rehearsalId: string): Promise<void> {
    const state = await this.getSession(rehearsalId).catch(() => null);
    await this.syncFinalRehearsalState(
      rehearsalId,
      RehearsalStatus.COMPLETED,
      state,
    );
  }

  async markCancelled(rehearsalId: string, reason?: string): Promise<void> {
    const state = await this.getSession(rehearsalId).catch(() => null);
    await this.syncFinalRehearsalState(
      rehearsalId,
      RehearsalStatus.CANCELLED,
      state,
    );
    await this.eventLogger.log(
      rehearsalId,
      RehearsalEventType.SESSION_FAILED,
      {
        runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
        ...(reason ? { reason } : {}),
      },
    );
  }

  async markSocketDisconnected(rehearsalId: string): Promise<void> {
    await this.updateSession(rehearsalId, {
      lastSocketDisconnectAt: new Date().toISOString(),
    });
  }

  /** End a session cleanly. Wipes Redis state, marks Rehersal COMPLETED. */
  async endSession(rehearsalId: string): Promise<void> {
    const state = await this.getSession(rehearsalId).catch(() => null);
    await this.clearSessionArtifacts(rehearsalId);
    await this.syncFinalRehearsalState(
      rehearsalId,
      RehearsalStatus.COMPLETED,
      state,
    );
    await this.eventLogger.log(
      rehearsalId,
      RehearsalEventType.SESSION_COMPLETED,
      {
        runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
      },
    );
    this.logger.log(`Teleprompter session ended: ${rehearsalId}`);
  }

  /** Force-reset a stuck session (DELETE /session/:id recovery path). */
  async forceReset(rehearsalId: string, userId: string): Promise<void> {
    const state = await this.getSession(rehearsalId).catch(() => null);
    if (state && state.userId !== userId) {
      // caller doesn't own this session — refuse silently from the service
      // layer; the controller surfaces 403.
      throw new NotFoundException(
        `Teleprompter session not found: ${rehearsalId}`,
      );
    }
    await this.clearSessionArtifacts(rehearsalId);
    await this.syncFinalRehearsalState(
      rehearsalId,
      RehearsalStatus.CANCELLED,
      state,
    );
    await this.eventLogger.log(
      rehearsalId,
      RehearsalEventType.SESSION_FAILED,
      {
        runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
        reason: 'force_reset',
      },
    );
    this.logger.warn(`Teleprompter session force-reset: ${rehearsalId}`);
  }

  // private helpers

  private async clearSessionArtifacts(rehearsalId: string): Promise<void> {
    const keys = await this.scanKeys(`tp:${rehearsalId}:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');
    return found;
  }

  private async syncRehearsalState(
    rehearsalId: string,
    patch: Partial<Rehersal>,
  ): Promise<void> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      this.logger.warn(`Unable to sync missing rehearsal: ${rehearsalId}`);
      return;
    }

    if (patch.status) {
      try {
        assertValidTransition(rehearsal.status, patch.status);
      } catch (err: any) {
        this.logger.warn(
          `${err.message} (rehearsal=${rehearsalId}). Proceeding anyway.`,
        );
      }
    }

    await this.rehersalRepository.updateById(rehearsalId, patch);
  }

  private async syncFinalRehearsalState(
    rehearsalId: string,
    finalStatus: RehearsalStatus,
    state?: TeleprompterSessionState | null,
  ): Promise<void> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      this.logger.warn(
        `Unable to sync final state for missing rehearsal: ${rehearsalId}`,
      );
      return;
    }

    const endedAt = new Date();
    const totalPausedMs =
      (state?.totalPausedMs ?? 0) +
      (state?.pausedAt
        ? Math.max(0, endedAt.getTime() - new Date(state.pausedAt).getTime())
        : 0);
    const sessionDurationSeconds = rehearsal.startedAt
      ? Math.max(
          0,
          Math.floor(
            (endedAt.getTime() -
              rehearsal.startedAt.getTime() -
              totalPausedMs) /
              1000,
          ),
        )
      : rehearsal.sessionDurationSeconds;

    await this.syncRehearsalState(rehearsalId, {
      status: finalStatus,
      runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
      endedAt,
      sessionDurationSeconds,
    });
  }
}
