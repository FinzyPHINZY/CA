// HazelSessionService — manages Hazel session state in Redis (tasks 4.1.5, 4.1.6, 4.1.7).

// Redis keys:
//   hazel:{rehearsalId}:state  → JSON-serialized HazelSessionState (TTL: 4h)
//   lock:hazel:lock:{userId}   → distributed lock (via RedisLockService, TTL: HAZEL_MAX_SESSION_HOURS)

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  AuthClientService,
  RedisLockService,
  RehearsalEventType,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Rehersal,
  RehersalRepository,
  SESSION_DEFAULTS,
  SessionSettings,
  normalizeDetectionMode,
  assertValidTransition,
} from '@app/common';
import type {
  HazelSessionState,
  SessionStatus,
  TurnType,
} from './types/hazel.types';
import { HazelEventLoggerService } from './hazel-event-logger.service';

const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4 hours

@Injectable()
export class HazelSessionService {
  private readonly logger = new Logger(HazelSessionService.name);
  private readonly maxSessionHours: number;
  private readonly disconnectGraceSeconds: number;

  // in-memory map of userId → lockToken for releasing locks on session.end
  private readonly lockTokens = new Map<string, string>();

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly redisLock: RedisLockService,
    private readonly configService: ConfigService,
    private readonly rehersalRepository: RehersalRepository,
    private readonly eventLogger: HazelEventLoggerService,
    private readonly authClient: AuthClientService,
  ) {
    this.maxSessionHours = this.configService.get<number>(
      'HAZEL_MAX_SESSION_HOURS',
      4,
    );
    this.disconnectGraceSeconds = this.configService.get<number>(
      'HAZEL_DISCONNECT_GRACE_SECONDS',
      300,
    );
  }

  private stateKey(rehearsalId: string) {
    return `hazel:${rehearsalId}:state`;
  }

  private lockKey(userId: string) {
    return `hazel:lock:${userId}`;
  }

  // lock helpers

  // acquire the per-user concurrency lock.
  // returns false if the user already has an active session.
  async acquireUserLock(
    userId: string,
  ): Promise<{ acquired: boolean; lockToken: string | null }> {
    const result = await this.redisLock.acquireLock(
      this.lockKey(userId),
      this.maxSessionHours * 60 * 60,
    );
    if (result.acquired && result.lockToken) {
      this.lockTokens.set(userId, result.lockToken);
      this.logger.debug(`Hazel lock acquired for user ${userId}`);
    }
    return result;
  }

  async releaseUserLock(
    userId: string,
    lockToken?: string | null,
  ): Promise<void> {
    const token = lockToken ?? this.lockTokens.get(userId);
    if (token) {
      await this.redisLock.releaseLock(this.lockKey(userId), token);
      this.lockTokens.delete(userId);
      this.logger.debug(`Hazel lock released for user ${userId}`);
      return;
    }

    await this.forceReleaseUserLock(userId);
  }

  async forceReleaseUserLock(userId: string): Promise<void> {
    await this.redis.del(`lock:${this.lockKey(userId)}`);
    this.lockTokens.delete(userId);
    this.logger.warn(`Hazel lock force-released for user ${userId}`);
  }

  // CRUD

  async createSession(
    userId: string,
    rehearsalId: string,
    sceneId: string,
    characterId: string,
    voiceMap: Record<string, string> = {},
    lockToken: string | null = null,
  ): Promise<void> {
    const state: HazelSessionState = {
      rehearsalId,
      userId,
      lockToken,
      sceneId,
      characterId,
      currentLineIndex: 0,
      currentTurn: 'actor',
      status: 'preparing',
      voiceMap,
      isHazelSpeaking: false,
      lastHazelLineIndex: -1,
      totalLines: 0,
      deepgramKeyId: '',
      startedAt: new Date().toISOString(),
      lastSocketDisconnectAt: null,
      pausedAt: null,
      totalPausedMs: 0,
      recordingChannelName: null,
      agoraResourceId: null,
      agoraSid: null,
      previousHazelCharacterName: null,
      settings: { ...SESSION_DEFAULTS },
      loopIteration: 0,
      actorTurnStartedAt: null,
    };
    await this.redis.set(
      this.stateKey(rehearsalId),
      JSON.stringify(state),
      'EX',
      SESSION_TTL_SECONDS,
    );
    this.logger.log(`Session created: ${rehearsalId}`);
  }

  async getSession(rehearsalId: string): Promise<HazelSessionState> {
    const raw = await this.redis.get(this.stateKey(rehearsalId));
    if (!raw) {
      throw new NotFoundException(`Hazel session not found: ${rehearsalId}`);
    }
    return JSON.parse(raw) as HazelSessionState;
  }

  async updateSession(
    rehearsalId: string,
    patch: Partial<HazelSessionState>,
  ): Promise<HazelSessionState> {
    const current = await this.getSession(rehearsalId);
    const updated = { ...current, ...patch };
    // preserve remaining TTL by re-setting with the original 4-hour TTL
    await this.redis.set(
      this.stateKey(rehearsalId),
      JSON.stringify(updated),
      'EX',
      SESSION_TTL_SECONDS,
    );
    return updated;
  }

  async endSession(rehearsalId: string): Promise<void> {
    const state = await this.getSession(rehearsalId);
    await this.releaseUserLock(state.userId, state.lockToken);
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
        runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      },
    );
    this.logger.log(`Session ended: ${rehearsalId}`);
  }

  async forceResetSession(
    rehearsalId: string,
    userId: string,
    finalStatus: RehearsalStatus = RehearsalStatus.CANCELLED,
    eventData?: Record<string, any>,
  ): Promise<void> {
    const state = await this.getSession(rehearsalId).catch(() => null);
    const lockUserId = state?.userId ?? userId;
    await this.releaseUserLock(lockUserId, state?.lockToken);
    await this.clearSessionArtifacts(rehearsalId);
    await this.syncFinalRehearsalState(rehearsalId, finalStatus, state);
    await this.eventLogger.log(
      rehearsalId,
      finalStatus === RehearsalStatus.FAILED
        ? RehearsalEventType.SESSION_FAILED
        : RehearsalEventType.SESSION_CANCELLED,
      {
        runtimeEngine: RehearsalRuntimeEngine.HAZEL,
        ...eventData,
      },
    );
    this.logger.warn(`Session force-reset: ${rehearsalId}`);
  }

  async recoverStaleSessionsForUser(userId: string): Promise<boolean> {
    const sessions = await this.findSessionsByUser(userId);
    if (sessions.length === 0) {
      await this.forceReleaseUserLock(userId);
      return true;
    }

    const nonRecoverable = sessions.find(
      (session) => !this.isRecoverableSession(session),
    );
    if (nonRecoverable) {
      return false;
    }

    for (const session of sessions) {
      await this.forceResetSession(session.rehearsalId, userId);
    }
    await this.forceReleaseUserLock(userId);
    return true;
  }

  async sessionExists(rehearsalId: string): Promise<boolean> {
    return this.redisLock.exists(this.stateKey(rehearsalId));
  }

  async setStatus(rehearsalId: string, status: SessionStatus): Promise<void> {
    await this.updateSession(rehearsalId, { status });
  }

  async markPreparing(rehearsalId: string, characterId: string): Promise<void> {
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.PREPARING,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      characterId,
      startedAt: null,
      endedAt: null,
      sessionDurationSeconds: null,
      metaData: {
        setup: {
          characterSelectionRequired: true,
          characterSelected: true,
        },
      },
    });
    await this.eventLogger.log(
      rehearsalId,
      RehearsalEventType.SESSION_PREPARING,
      {
        characterId,
        runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      },
    );
  }

  async markReady(rehearsalId: string): Promise<void> {
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.READY,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
    });
    await this.eventLogger.log(rehearsalId, RehearsalEventType.SESSION_READY, {
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
    });
  }

  async markFailed(rehearsalId: string): Promise<void> {
    await this.syncFinalRehearsalState(rehearsalId, RehearsalStatus.FAILED);
    await this.eventLogger.log(rehearsalId, RehearsalEventType.SESSION_FAILED, {
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
    });
  }

  async markActive(rehearsalId: string): Promise<void> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      this.logger.warn(
        `Unable to mark missing rehearsal as ACTIVE: ${rehearsalId}`,
      );
      return;
    }

    // freeze settings snapshot at session start (idempotent)
    const frozenSettings = await this.freezeSettings(rehearsal);

    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.ACTIVE,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      startedAt: rehearsal.startedAt ?? new Date(),
      endedAt: null,
      sessionSettings: frozenSettings,
    });

    // push frozen settings into Redis state so detectors/sequencer read them
    try {
      await this.updateSession(rehearsalId, { settings: frozenSettings });
    } catch (err: any) {
      this.logger.warn(
        `Failed to push frozen settings to Redis for ${rehearsalId}: ${err?.message ?? err}`,
      );
    }
    if (rehearsal.status !== RehearsalStatus.ACTIVE) {
      await this.eventLogger.log(
        rehearsalId,
        RehearsalEventType.SESSION_STARTED,
        {
          runtimeEngine: RehearsalRuntimeEngine.HAZEL,
          characterId: rehearsal.characterId ?? undefined,
        },
      );
    }
  }

  async markPaused(rehearsalId: string): Promise<void> {
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.PAUSED,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
    });
  }

  async markResumed(rehearsalId: string): Promise<void> {
    await this.syncRehearsalState(rehearsalId, {
      status: RehearsalStatus.ACTIVE,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
    });
  }

  async setCurrentTurn(
    rehearsalId: string,
    turnType: TurnType,
    lineIndex: number,
  ): Promise<void> {
    await this.updateSession(rehearsalId, {
      currentTurn: turnType,
      currentLineIndex: lineIndex,
    });
  }

  async markSocketDisconnected(rehearsalId: string): Promise<void> {
    await this.updateSession(rehearsalId, {
      lastSocketDisconnectAt: new Date().toISOString(),
    });
  }

  async clearSocketDisconnect(rehearsalId: string): Promise<void> {
    await this.updateSession(rehearsalId, {
      lastSocketDisconnectAt: null,
    });
  }

  private async clearSessionArtifacts(rehearsalId: string): Promise<void> {
    const keys = await this.scanKeys(`hazel:${rehearsalId}:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  // public: resolve + persist frozen session settings for a rehearsal.
  // idempotent — returns existing snapshot if already frozen.
  // also pushes the snapshot into Redis state so detectors/sequencer pick it up.
  async resolveAndPushSettings(rehearsalId: string): Promise<SessionSettings> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal not found: ${rehearsalId}`);
    }
    const settings = await this.freezeSettings(rehearsal);
    if (!rehearsal.sessionSettings) {
      await this.rehersalRepository.updateById(rehearsalId, {
        sessionSettings: settings,
      });
    }
    try {
      await this.updateSession(rehearsalId, { settings });
    } catch (err: any) {
      this.logger.warn(
        `Failed to push settings to Redis for ${rehearsalId}: ${err?.message ?? err}`,
      );
    }
    return settings;
  }

  // resolve user defaults + per-rehearsal override → frozen snapshot.
  // returns existing snapshot if already frozen.
  private async freezeSettings(rehearsal: Rehersal): Promise<SessionSettings> {
    if (rehearsal.sessionSettings) {
      return {
        ...rehearsal.sessionSettings,
        detectionMode: normalizeDetectionMode(
          rehearsal.sessionSettings.detectionMode,
        ),
      };
    }

    const override =
      (rehearsal.metaData?.settingsOverride as
        | Partial<SessionSettings>
        | undefined) ?? null;

    const userPrefs = await this.authClient.getUserRehearsalPreferences(
      rehearsal.userId,
    );
    const userSession = userPrefs.sessionDefaults;

    return {
      detectionMode: normalizeDetectionMode(
        override?.detectionMode ?? userSession.detectionMode,
      ),
      wordTracking:
        override?.wordTracking ??
        userSession.wordTracking ??
        SESSION_DEFAULTS.wordTracking,
      autoRecord:
        override?.autoRecord ??
        userSession.autoRecord ??
        SESSION_DEFAULTS.autoRecord,
      loopMode:
        override?.loopMode ?? userSession.loopMode ?? SESSION_DEFAULTS.loopMode,
    };
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

    const mergedMetaData = this.mergeMetaData(
      rehearsal.metaData,
      patch.metaData,
    );

    await this.rehersalRepository.updateById(rehearsalId, {
      ...patch,
      metaData: mergedMetaData,
    });
  }

  private async syncFinalRehearsalState(
    rehearsalId: string,
    finalStatus: RehearsalStatus,
    state?: HazelSessionState | null,
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
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      endedAt,
      sessionDurationSeconds,
    });
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

  private async findSessionsByUser(
    userId: string,
  ): Promise<HazelSessionState[]> {
    const stateKeys = await this.scanKeys('hazel:*:state');
    const sessions = await Promise.all(
      stateKeys.map(async (key) => {
        const raw = await this.redis.get(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as HazelSessionState;
        return parsed.userId === userId ? parsed : null;
      }),
    );
    return sessions.filter(Boolean) as HazelSessionState[];
  }

  private isRecoverableSession(session: HazelSessionState): boolean {
    if (
      session.status === 'preparing' ||
      session.status === 'ready' ||
      session.status === 'ended'
    ) {
      return true;
    }

    if (
      (session.status === 'active' || session.status === 'paused') &&
      session.lastSocketDisconnectAt
    ) {
      const disconnectedAt = new Date(session.lastSocketDisconnectAt).getTime();
      return Date.now() - disconnectedAt > this.disconnectGraceSeconds * 1000;
    }

    return false;
  }

  private mergeMetaData(
    current: Record<string, any> | null,
    patch: Record<string, any> | null | undefined,
  ): Record<string, any> | null {
    if (!patch) {
      return current ?? null;
    }

    const merged = {
      ...(current ?? {}),
      ...patch,
    };

    if (current?.setup || patch.setup) {
      merged.setup = {
        ...(current?.setup ?? {}),
        ...(patch.setup ?? {}),
      };
    }

    return merged;
  }
}
