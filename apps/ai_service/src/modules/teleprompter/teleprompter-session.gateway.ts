// Authentication: JWT in socket.handshake.auth.token validated via auth_service TCP.
// Each socket joins the room named `rehearsalId` so events scope per session.
//
// Events received: session.start, session.pause, session.resume, session.end,
//                  transcript.received, cue.skip, cue.back, session.jump_to,
//                  manual:advance
// Events emitted:  session.started, session.paused, session.resumed,
//                  session.ended, session.scene_complete,
//                  line.next, line.index_changed,
//                  action.display, parenthetical.display,
//                  cue.partial_match, cue.no_match, cue.stuck, cue.drift_reset,
//                  error
//
// Key differences vs Hazel gateway:
//   - No `currentTurn === 'actor'` gate on transcripts — speaker-agnostic.
//   - No isHazelSpeaking echo gate, no audio pipeline.
//   - `session.start` builds the sequence inline (no prepare/poll step).
//   - Detection modes are AUTO (default) and MANUAL only.

/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { firstValueFrom } from 'rxjs';
import { ClientProxy } from '@nestjs/microservices';
import { AUTH_SERVICE, RehearsalEventType } from '@app/common';

import { TeleprompterSessionService } from './teleprompter-session.service';
import { TeleprompterSequenceBuilder } from './teleprompter-sequence.builder';
import { TeleprompterSequencerService } from './teleprompter-sequencer.service';
import { TeleprompterEventLoggerService } from './teleprompter-event-logger.service';
import { CueDetectionService } from '../cue-engine/cue-detection.service';
import { CursorCueDetectionService } from '../cue-engine/cursor-cue-detection.service';
import { CursorStateService } from '../cue-engine/cursor-state.service';
import { SilenceDetectionService } from '../cue-engine/silence-detection.service';
import { DeepgramService } from '../cue-engine/deepgram.service';
import type { CueDecision } from '../cue-engine/types/cue-engine.types';
import type { TeleprompterTurn } from './types/teleprompter.types';

// Subscription gating is enforced upstream at the REST chokepoints
// (POST /api/rehearsals/teleprompter and GET /api/teleprompter/deepgram-token).
// FeatureGuard cannot meaningfully run at the WS layer — it inspects an HTTP
// request that doesn't exist in the Socket.io context. A user without the
// TELEPROMPTER feature cannot create a rehearsal or mint a Deepgram token, so
// `session.start` here fails at `getOwnedRehearsal` even if they reach the gateway.
@WebSocketGateway({
  namespace: '/teleprompter',
  cors: { origin: '*', credentials: true },
})
export class TeleprompterSessionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private static readonly MAX_LINE_MISMATCH = 2;
  private static readonly MISMATCH_MIN_WORDS = 3;
  private static readonly MISMATCH_MAX_RATIO = 0.2;
  private static readonly LINE_PROGRESS_FALLBACK_MIN_CONFIDENCE = 0.85;
  private static readonly QUIET_RESET_MS = 1500;
  private static readonly STALE_FINAL_FENCE_MS = 1500;
  private static readonly STUCK_PARTIAL_FINAL_THRESHOLD = 2;
  private static readonly STUCK_WINDOW_MS = 12000;

  @WebSocketServer() server: Server;

  private readonly logger = new Logger(TeleprompterSessionGateway.name);

  /** socket.id → { userId, rehearsalId } */
  private readonly socketMap = new Map<
    string,
    { userId: string; rehearsalId: string | null }
  >();

  /** rehearsalId → pending quiet-reset timer */
  private readonly quietResetTimers = new Map<string, NodeJS.Timeout>();

  /**
   * rehearsalId → post-interim-advance fence. Suppresses the next stale FINAL
   * that Deepgram emits for the prior utterance after an interim already
   * triggered advance.
   */
  private readonly postInterimAdvanceFence = new Map<
    string,
    { fromLineIndex: number; expiresAt: number }
  >();

  /** rehearsalId → per-line partial-band stagnation tracker. */
  private readonly stuckTracker = new Map<
    string,
    {
      lineIndex: number;
      partialFinalCount: number;
      firstPartialAt: number;
      emitted: boolean;
    }
  >();

  private static readonly transcriptPayloadError = {
    code: 'INVALID_TRANSCRIPT_PAYLOAD',
    message:
      'Malformed transcript payload. Provide rehearsalId, transcript, and isFinal.',
  };

  constructor(
    @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
    private readonly sessionService: TeleprompterSessionService,
    private readonly sequenceBuilder: TeleprompterSequenceBuilder,
    private readonly sequencer: TeleprompterSequencerService,
    private readonly eventLogger: TeleprompterEventLoggerService,
    private readonly cueDetection: CueDetectionService,
    private readonly cursorCueDetection: CursorCueDetectionService,
    private readonly cursorStateService: CursorStateService,
    private readonly silenceDetection: SilenceDetectionService,
    private readonly deepgramService: DeepgramService,
  ) {}

  // connection lifecycle

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = socket.handshake.auth?.token as string;
      if (!token) {
        socket.emit('error', {
          code: 'AUTH_REQUIRED',
          message: 'Authentication token required',
        });
        socket.disconnect(true);
        return;
      }

      const user = await firstValueFrom(
        this.authClient.send('auth.validateToken', { token }),
      );

      if (!user?.id) {
        socket.emit('error', {
          code: 'AUTH_INVALID',
          message: 'Invalid token',
        });
        socket.disconnect(true);
        return;
      }

      this.socketMap.set(socket.id, { userId: user.id, rehearsalId: null });
      (socket as any).userId = user.id;
      this.logger.log(`WS connected: ${socket.id} (user=${user.id})`);
    } catch {
      socket.emit('error', {
        code: 'AUTH_ERROR',
        message: 'Authentication failed',
      });
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const meta = this.socketMap.get(socket.id);
    this.socketMap.delete(socket.id);
    if (meta?.rehearsalId) {
      this.cancelQuietReset(meta.rehearsalId);
      this.clearStaleFinalFence(meta.rehearsalId);
      this.clearStuckTracker(meta.rehearsalId);
      await this.sessionService
        .markSocketDisconnected(meta.rehearsalId)
        .catch(() => null);
      this.logger.log(
        `WS disconnected: ${socket.id} (rehearsal=${meta.rehearsalId})`,
      );
    }
  }

  // session.start — builds sequence inline, mints Deepgram key, dispatches turn 0.
  @SubscribeMessage('session.start')
  async onSessionStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      rehearsalId: string;
      detectionMode?: 'AUTO' | 'MANUAL';
      silencePace?: 'fast' | 'normal' | 'patient';
      includeActions?: boolean;
    },
  ): Promise<void> {
    const userId = (socket as any).userId as string;
    const { rehearsalId } = data ?? {};

    if (!rehearsalId) {
      socket.emit('error', {
        code: 'INVALID_REQUEST',
        message: 'rehearsalId is required',
      });
      return;
    }

    try {
      // Initialize Redis state. We always create fresh — if there's existing
      // state, it gets overwritten (acts as auto-recovery for stale sessions).
      const initialSettings = {
        detectionMode: data.detectionMode ?? 'AUTO',
        silencePace: data.silencePace ?? 'normal',
        autoAdvanceOnSilence: true,
        includeActions: data.includeActions ?? false,
      } as const;

      // Need sceneId — load from Rehersal row via session service helper.
      // Use a temporary state read to drive this: actually we load it via
      // the sequence builder which itself takes sceneId. So fetch the
      // rehearsal first to get sceneId.
      const sceneId = await this.resolveSceneId(rehearsalId, userId, socket);
      if (!sceneId) return; // error already emitted

      await this.sessionService.createInitialState(
        userId,
        rehearsalId,
        sceneId,
        initialSettings,
      );

      socket.join(rehearsalId);
      const meta = this.socketMap.get(socket.id);
      if (meta) meta.rehearsalId = rehearsalId;

      // Build sequence + cursor index inline (≤50ms; no separate prepare step).
      const sequence = await this.sequenceBuilder.buildForScene(
        rehearsalId,
        sceneId,
        initialSettings.includeActions,
      );
      if (sequence.length === 0) {
        socket.emit('error', {
          code: 'EMPTY_SEQUENCE',
          message: 'Scene has no usable elements',
        });
        await this.sessionService.forceReset(rehearsalId, userId);
        return;
      }

      // Mint Deepgram session key (skip in MANUAL mode — no speech needed,
      // but FE may still request one for opt-in dictation; cheaper to mint).
      let deepgramKeyId: string | null = null;
      try {
        const key = await this.deepgramService.createSessionKey(rehearsalId);
        deepgramKeyId = key.keyId;
      } catch (err: any) {
        this.logger.warn(
          `Deepgram key mint failed for ${rehearsalId}: ${err.message}`,
        );
      }

      await this.sessionService.updateSession(rehearsalId, {
        status: 'active',
        totalLines: sequence.length,
        deepgramKeyId,
      });
      await this.sessionService.markActive(rehearsalId);

      this.eventLogger.setSessionMode(
        rehearsalId,
        initialSettings.detectionMode,
      );

      const keywords = await this.sequencer.getKeywordsForLine(rehearsalId, 0);

      socket.emit('session.started', {
        rehearsalId,
        totalLines: sequence.length,
        deepgramModel: this.deepgramService.model,
        deepgramKeywords: keywords,
      });

      const firstTurn = sequence[0];
      await this.sessionService.setCurrentTurn(rehearsalId, firstTurn.kind, 0);
      await this.sequencer.emitLineIndexChanged(
        rehearsalId,
        0,
        firstTurn,
        this.server,
      );

      const state = await this.sessionService.getSession(rehearsalId);
      await this.sequencer.dispatchTurn(
        rehearsalId,
        firstTurn,
        state,
        this.server,
      );
    } catch (err: any) {
      this.logger.error(`session.start error: ${err.message}`);
      socket.emit('error', { code: 'SESSION_ERROR', message: err.message });
    }
  }

  @SubscribeMessage('session.end')
  async onSessionEnd(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const userId = (socket as any).userId as string;
    const { rehearsalId } = data ?? {};

    try {
      const state = await this.sessionService
        .getSession(rehearsalId)
        .catch(() => null);
      if (!state || state.userId !== userId) return;

      this.sequencer.cleanup(rehearsalId);
      this.cancelQuietReset(rehearsalId);
      this.clearStaleFinalFence(rehearsalId);
      this.clearStuckTracker(rehearsalId);

      if (state.deepgramKeyId) {
        await this.deepgramService.revokeKey(state.deepgramKeyId);
      }

      await this.sessionService.endSession(rehearsalId);
      await this.eventLogger.flushSession(rehearsalId);

      this.server.to(rehearsalId).emit('session.ended', { rehearsalId });
      socket.leave(rehearsalId);
    } catch (err: any) {
      this.logger.error(`session.end error: ${err.message}`);
    }
  }

  @SubscribeMessage('session.pause')
  async onSessionPause(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state || state.userId !== (socket as any).userId) return;
    if (state.status !== 'active') return;

    this.sequencer.cancelPauseTimer(data.rehearsalId);
    this.silenceDetection.clearTimer(data.rehearsalId);
    this.cancelQuietReset(data.rehearsalId);
    this.clearStaleFinalFence(data.rehearsalId);
    this.clearStuckTracker(data.rehearsalId);

    await this.sessionService.updateSession(data.rehearsalId, {
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });
    await this.sessionService.markPaused(data.rehearsalId);
    await this.eventLogger.log(data.rehearsalId, RehearsalEventType.PAUSE, {
      lineIndex: state.currentLineIndex,
      currentTurn: state.currentTurn,
    });

    this.server
      .to(data.rehearsalId)
      .emit('session.paused', { rehearsalId: data.rehearsalId });
  }

  @SubscribeMessage('session.resume')
  async onSessionResume(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state || state.userId !== (socket as any).userId) return;
    if (state.status !== 'paused') return;

    const pausedMs = state.pausedAt
      ? Date.now() - new Date(state.pausedAt).getTime()
      : 0;

    const updated = await this.sessionService.updateSession(data.rehearsalId, {
      status: 'active',
      pausedAt: null,
      totalPausedMs: state.totalPausedMs + pausedMs,
    });
    await this.sessionService.markResumed(data.rehearsalId);
    await this.eventLogger.log(data.rehearsalId, RehearsalEventType.RESUME, {
      lineIndex: state.currentLineIndex,
      pauseDurationMs: pausedMs,
    });

    this.server
      .to(data.rehearsalId)
      .emit('session.resumed', { rehearsalId: data.rehearsalId });

    // Re-dispatch current turn to restore action/parenthetical timers.
    const turn = await this.sequenceBuilder.getTurn(
      data.rehearsalId,
      state.currentLineIndex,
    );
    if (turn) {
      await this.sequencer.dispatchTurn(
        data.rehearsalId,
        turn,
        updated,
        this.server,
      );
    }
  }

  // transcript.received — speaker-agnostic; NO currentTurn === 'actor' gate.
  @SubscribeMessage('transcript.received')
  async onTranscriptReceived(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      rehearsalId: string;
      transcript: string;
      confidence?: number;
      isFinal?: boolean;
    },
  ): Promise<void> {
    try {
      const normalized = this.normalizeTranscriptPayload(data);
      if (!normalized) {
        socket.emit('error', TeleprompterSessionGateway.transcriptPayloadError);
        return;
      }

      this.cancelQuietReset(normalized.rehearsalId);

      const state = await this.sessionService.getSession(
        normalized.rehearsalId,
      );

      if (state.status !== 'active') return;
      // No currentTurn === 'actor' gate. Only skip non-line turns where
      // there's nothing to advance against.
      if (state.currentTurn !== 'line') return;

      const detectionMode = state.settings?.detectionMode ?? 'AUTO';
      if (detectionMode === 'MANUAL') return;

      if (
        this.isStaleFinalDrop(
          normalized.rehearsalId,
          normalized.isInterim,
          state.currentLineIndex,
        )
      ) {
        this.clearStaleFinalFence(normalized.rehearsalId);
        return;
      }

      const turn = await this.sequenceBuilder.getTurn(
        normalized.rehearsalId,
        state.currentLineIndex,
      );
      if (!turn || turn.kind !== 'line') return;

      const transcriptState = await this.sessionService.recordTranscript(
        normalized.rehearsalId,
        normalized.transcript,
        normalized.isInterim,
      );

      const expectedLine = turn.lines.join(' ');

      const result = await this.cursorCueDetection.evaluate(
        normalized.rehearsalId,
        transcriptState.accumulatedTranscript,
        state.currentLineIndex,
        expectedLine,
        normalized.isInterim,
        normalized.confidence,
      );
      const tailCoverage =
        'tailCoverage' in result ? Boolean(result.tailCoverage) : false;
      const lineProgress = this.evaluatePerLineProgress(
        transcriptState.accumulatedTranscript,
        turn.lines,
        normalized.isInterim,
        normalized.confidence,
      );

      const { actorTurnStartedAt } = this.silenceDetection.onTranscriptReceived(
        normalized.rehearsalId,
        result.matchRatio,
        transcriptState.accumulatedTranscript,
        !normalized.isInterim,
        tailCoverage,
        () => {
          void this.advanceOnSilence(
            normalized.rehearsalId,
            state.currentLineIndex,
            turn,
            transcriptState.accumulatedTranscript,
            result.matchRatio,
          );
        },
      );

      if (result.decision === 'advance') {
        this.silenceDetection.clearTimer(normalized.rehearsalId);
        const responseTimeMs = Date.now() - actorTurnStartedAt;
        await this.eventLogger.logTurnEvent(
          normalized.rehearsalId,
          RehearsalEventType.LINE_COMPLETED,
          turn,
          {
            matchRatio: result.matchRatio,
            responseTimeMs,
            triggerType: 'word_overlap',
          },
        );
        if (normalized.isInterim) {
          this.armStaleFinalFence(
            normalized.rehearsalId,
            state.currentLineIndex,
          );
        }
        await this.sequencer.advance(normalized.rehearsalId, this.server);
      } else if (
        !normalized.isInterim &&
        normalized.confidence >=
          TeleprompterSessionGateway.LINE_PROGRESS_FALLBACK_MIN_CONFIDENCE &&
        lineProgress.decision === 'advance'
      ) {
        // Jaccard fallback for high-confidence finals the cursor engine
        // rejected (typical: a 3-edit substitution like "about" → "able"
        // that per-word fuzzy can't bridge but line-level overlap clears).
        this.silenceDetection.clearTimer(normalized.rehearsalId);
        const responseTimeMs = Date.now() - actorTurnStartedAt;
        await this.eventLogger.logTurnEvent(
          normalized.rehearsalId,
          RehearsalEventType.LINE_COMPLETED,
          turn,
          {
            matchRatio: lineProgress.matchRatio,
            responseTimeMs,
            triggerType: 'line_progress_fallback',
          },
        );
        await this.sequencer.advance(normalized.rehearsalId, this.server);
      } else if (result.decision === 'drift_reset') {
        this.silenceDetection.clearTimer(normalized.rehearsalId);
        this.cancelQuietReset(normalized.rehearsalId);
        this.clearStaleFinalFence(normalized.rehearsalId);
        this.clearStuckTracker(normalized.rehearsalId);
        await this.sessionService.clearTranscriptBuffer(normalized.rehearsalId);
        await this.cursorStateService.resetCursorForTurn(
          normalized.rehearsalId,
          state.currentLineIndex,
        );
        socket.emit('cue.drift_reset', {
          lineIndex: state.currentLineIndex,
          reason: 'transcript_drift',
        });
      } else if (
        result.decision === 'partial' ||
        (result.decision === 'none' && lineProgress.decision !== 'none')
      ) {
        const effectiveMatchRatio = Math.max(
          result.matchRatio,
          lineProgress.matchRatio,
        );
        socket.emit('cue.partial_match', {
          lineIndex: state.currentLineIndex,
          matchRatio: effectiveMatchRatio,
          transcript: transcriptState.accumulatedTranscript,
        });
        if (!normalized.isInterim) {
          this.trackStuckPartial(
            normalized.rehearsalId,
            socket,
            state.currentLineIndex,
            effectiveMatchRatio,
          );
        }
        this.scheduleQuietReset(normalized.rehearsalId, state.currentLineIndex);
      } else if (
        this.isFailedAttempt(
          normalized.isInterim,
          transcriptState.accumulatedTranscript,
          result.matchRatio,
          tailCoverage,
          lineProgress,
        )
      ) {
        this.silenceDetection.clearTimer(normalized.rehearsalId);
        const mismatchState = await this.sessionService.registerMismatch(
          normalized.rehearsalId,
          transcriptState.accumulatedTranscript,
        );
        await this.eventLogger.logTurnEvent(
          normalized.rehearsalId,
          RehearsalEventType.CUE_NO_MATCH,
          turn,
          {
            transcript: transcriptState.accumulatedTranscript,
            matchRatio: result.matchRatio,
            mismatchCount: mismatchState.lineMismatchCount,
            maxMismatchCount: TeleprompterSessionGateway.MAX_LINE_MISMATCH,
          },
        );
        socket.emit('cue.no_match', {
          lineIndex: state.currentLineIndex,
          transcript: transcriptState.accumulatedTranscript,
          matchRatio: result.matchRatio,
          attempt: mismatchState.lineMismatchCount,
          maxAttempts: TeleprompterSessionGateway.MAX_LINE_MISMATCH,
          exhausted:
            mismatchState.lineMismatchCount >=
            TeleprompterSessionGateway.MAX_LINE_MISMATCH,
        });
        await this.sessionService.clearTranscriptBuffer(normalized.rehearsalId);
        await this.cursorStateService.resetCursorForTurn(
          normalized.rehearsalId,
          state.currentLineIndex,
        );
      }
    } catch (err: any) {
      if (err?.status === 404 || err?.message?.includes('not found')) {
        this.logger.debug(
          `transcript.received after session teardown (expected): ${err.message}`,
        );
      } else {
        this.logger.error(`transcript.received error: ${err.message}`);
      }
    }
  }

  // manual:advance — only honored in MANUAL detection mode.
  @SubscribeMessage('manual:advance')
  async onManualAdvance(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state || state.status !== 'active') return;
    if (state.currentTurn !== 'line') return;

    const detectionMode = state.settings?.detectionMode ?? 'AUTO';
    if (detectionMode !== 'MANUAL') return;

    const turn = await this.sequenceBuilder.getTurn(
      data.rehearsalId,
      state.currentLineIndex,
    );

    this.cancelQuietReset(data.rehearsalId);
    this.clearStaleFinalFence(data.rehearsalId);
    this.clearStuckTracker(data.rehearsalId);

    await this.eventLogger.logTurnEvent(
      data.rehearsalId,
      RehearsalEventType.LINE_COMPLETED,
      turn,
      { lineIndex: state.currentLineIndex, triggerType: 'manual_advance' },
    );

    await this.sequencer.advance(data.rehearsalId, this.server);
  }

  // cue.skip — escape hatch for any mode.
  @SubscribeMessage('cue.skip')
  async onCueSkip(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<{
    skipped: boolean;
    reason?: 'invalid_session' | 'not_active';
  }> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state) return { skipped: false, reason: 'invalid_session' };
    if (state.status !== 'active')
      return { skipped: false, reason: 'not_active' };

    const turn = await this.sequenceBuilder.getTurn(
      data.rehearsalId,
      state.currentLineIndex,
    );
    this.sequencer.cancelPauseTimer(data.rehearsalId);
    this.silenceDetection.clearTimer(data.rehearsalId);
    this.cancelQuietReset(data.rehearsalId);
    this.clearStaleFinalFence(data.rehearsalId);
    this.clearStuckTracker(data.rehearsalId);

    await this.eventLogger.logTurnEvent(
      data.rehearsalId,
      RehearsalEventType.LINE_SKIPPED,
      turn,
      { lineIndex: state.currentLineIndex },
    );

    await this.sequencer.advance(data.rehearsalId, this.server);
    return { skipped: true };
  }

  // cue.back — jump to previous line (skipping past action/parenthetical).
  @SubscribeMessage('cue.back')
  async onCueBack(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state) return;

    const sequence = await this.sequenceBuilder.getSequence(data.rehearsalId);
    let prevIndex = state.currentLineIndex - 1;

    while (
      prevIndex >= 0 &&
      sequence[prevIndex] &&
      sequence[prevIndex].kind !== 'line'
    ) {
      prevIndex--;
    }
    if (prevIndex < 0) return;

    this.sequencer.cancelPauseTimer(data.rehearsalId);
    this.silenceDetection.clearTimer(data.rehearsalId);
    this.cancelQuietReset(data.rehearsalId);
    this.clearStaleFinalFence(data.rehearsalId);
    this.clearStuckTracker(data.rehearsalId);

    await this.cursorStateService.resetCursorForTurn(
      data.rehearsalId,
      prevIndex,
    );
    await this.sequencer.jumpTo(
      data.rehearsalId,
      prevIndex,
      this.server,
      false,
    );
  }

  @SubscribeMessage('session.jump_to')
  async onJumpTo(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { rehearsalId: string; lineIndex: number },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state) return;

    this.sequencer.cancelPauseTimer(data.rehearsalId);
    this.silenceDetection.clearTimer(data.rehearsalId);
    this.cancelQuietReset(data.rehearsalId);
    this.clearStaleFinalFence(data.rehearsalId);
    this.clearStuckTracker(data.rehearsalId);

    await this.cursorStateService.resetCursorForTurn(
      data.rehearsalId,
      data.lineIndex,
    );
    await this.sequencer.jumpTo(
      data.rehearsalId,
      data.lineIndex,
      this.server,
      true,
    );
  }

  // helpers

  private async resolveSceneId(
    rehearsalId: string,
    userId: string,
    socket: Socket,
  ): Promise<string | null> {
    try {
      const rehearsal = await this.sessionService.getOwnedRehearsal(
        rehearsalId,
        userId,
      );
      if (!rehearsal) {
        socket.emit('error', {
          code: 'NOT_FOUND_OR_FORBIDDEN',
          message: `Rehearsal ${rehearsalId} not found or not yours`,
        });
        return null;
      }
      if (!rehearsal.sceneId) {
        socket.emit('error', {
          code: 'INVALID_STATE',
          message: 'Rehearsal has no linked scene',
        });
        return null;
      }
      return rehearsal.sceneId;
    } catch (err: any) {
      socket.emit('error', { code: 'SESSION_ERROR', message: err.message });
      return null;
    }
  }

  private isFailedAttempt(
    isInterim: boolean,
    transcript: string,
    matchRatio: number,
    tailCoverage: boolean,
    lineProgress: CueDecision,
  ): boolean {
    if (isInterim) return false;
    if (lineProgress.decision !== 'none') return false;
    if (tailCoverage) return false;
    if (matchRatio >= TeleprompterSessionGateway.MISMATCH_MAX_RATIO)
      return false;
    return (
      this.countWords(transcript) >=
      TeleprompterSessionGateway.MISMATCH_MIN_WORDS
    );
  }

  private evaluatePerLineProgress(
    transcript: string,
    lines: string[],
    isInterim: boolean,
    confidence: number,
  ): CueDecision {
    let best: CueDecision = { matchRatio: 0, decision: 'none' };
    for (const line of lines) {
      const candidate = this.cueDetection.evaluate(
        transcript,
        line,
        isInterim,
        confidence,
      );
      if (this.isStrongerCueDecision(candidate, best)) {
        best = candidate;
      }
    }
    return best;
  }

  private isStrongerCueDecision(
    candidate: CueDecision,
    current: CueDecision,
  ): boolean {
    const rank = { none: 0, partial: 1, advance: 2 } as const;
    const candidateRank = rank[candidate.decision];
    const currentRank = rank[current.decision];
    if (candidateRank !== currentRank) return candidateRank > currentRank;
    return candidate.matchRatio > current.matchRatio;
  }

  private countWords(text: string): number {
    const normalized = text.trim();
    if (!normalized) return 0;
    return normalized.split(/\s+/).length;
  }

  private async advanceOnSilence(
    rehearsalId: string,
    lineIndex: number,
    turn: TeleprompterTurn,
    accumulatedTranscript: string,
    matchRatio: number,
  ): Promise<void> {
    const state = await this.sessionService.getSession(rehearsalId);
    if (state.settings && state.settings.autoAdvanceOnSilence === false) return;

    await this.eventLogger.logTurnEvent(
      rehearsalId,
      RehearsalEventType.LINE_COMPLETED,
      turn,
      {
        lineIndex,
        triggerType: 'silence',
        transcript: accumulatedTranscript,
        matchRatio,
      },
    );
    await this.sequencer.advance(rehearsalId, this.server);
  }

  // stale-final fence (post-interim-advance suppression)

  private armStaleFinalFence(rehearsalId: string, fromLineIndex: number): void {
    this.postInterimAdvanceFence.set(rehearsalId, {
      fromLineIndex,
      expiresAt: Date.now() + TeleprompterSessionGateway.STALE_FINAL_FENCE_MS,
    });
  }

  private clearStaleFinalFence(rehearsalId: string): void {
    this.postInterimAdvanceFence.delete(rehearsalId);
  }

  private isStaleFinalDrop(
    rehearsalId: string,
    isInterim: boolean,
    currentLineIndex: number,
  ): boolean {
    const fence = this.postInterimAdvanceFence.get(rehearsalId);
    if (!fence) return false;
    if (Date.now() >= fence.expiresAt) {
      this.postInterimAdvanceFence.delete(rehearsalId);
      return false;
    }
    if (isInterim) {
      this.postInterimAdvanceFence.delete(rehearsalId);
      return false;
    }
    return currentLineIndex > fence.fromLineIndex;
  }

  // stuck tracker (partial-band stagnation → cue.stuck)

  private trackStuckPartial(
    rehearsalId: string,
    socket: Socket,
    lineIndex: number,
    matchRatio: number,
  ): void {
    const now = Date.now();
    const existing = this.stuckTracker.get(rehearsalId);

    if (!existing || existing.lineIndex !== lineIndex) {
      this.stuckTracker.set(rehearsalId, {
        lineIndex,
        partialFinalCount: 1,
        firstPartialAt: now,
        emitted: false,
      });
      return;
    }

    if (existing.emitted) return;

    if (
      now - existing.firstPartialAt >
      TeleprompterSessionGateway.STUCK_WINDOW_MS
    ) {
      existing.partialFinalCount = 1;
      existing.firstPartialAt = now;
      return;
    }

    existing.partialFinalCount += 1;
    if (
      existing.partialFinalCount >=
      TeleprompterSessionGateway.STUCK_PARTIAL_FINAL_THRESHOLD
    ) {
      existing.emitted = true;
      const durationMs = now - existing.firstPartialAt;
      socket.emit('cue.stuck', {
        lineIndex,
        matchRatio,
        attempts: existing.partialFinalCount,
        durationMs,
        reason: 'partial_stagnation',
      });
    }
  }

  private clearStuckTracker(rehearsalId: string): void {
    this.stuckTracker.delete(rehearsalId);
  }

  // quiet-reset (pause-after-botched-attempt → rewind cursor)

  private cancelQuietReset(rehearsalId: string): void {
    const t = this.quietResetTimers.get(rehearsalId);
    if (t) {
      clearTimeout(t);
      this.quietResetTimers.delete(rehearsalId);
    }
  }

  private scheduleQuietReset(rehearsalId: string, lineIndex: number): void {
    this.cancelQuietReset(rehearsalId);
    const timer = setTimeout(async () => {
      this.quietResetTimers.delete(rehearsalId);
      try {
        const state = await this.sessionService
          .getSession(rehearsalId)
          .catch(() => null);
        if (
          !state ||
          state.status !== 'active' ||
          state.currentTurn !== 'line' ||
          state.currentLineIndex !== lineIndex
        ) {
          return;
        }
        await this.sessionService.clearTranscriptBuffer(rehearsalId);
        await this.cursorStateService.resetCursorForTurn(
          rehearsalId,
          lineIndex,
        );
      } catch (err: any) {
        this.logger.warn(
          `Quiet reset failed for ${rehearsalId}: ${err.message}`,
        );
      }
    }, TeleprompterSessionGateway.QUIET_RESET_MS);
    this.quietResetTimers.set(rehearsalId, timer);
  }

  private normalizeTranscriptPayload(data: {
    rehearsalId?: string;
    transcript?: string;
    confidence?: number;
    isFinal?: boolean;
  }): {
    rehearsalId: string;
    transcript: string;
    confidence: number;
    isInterim: boolean;
  } | null {
    if (!data || typeof data.rehearsalId !== 'string' || !data.rehearsalId) {
      return null;
    }
    if (typeof data.transcript !== 'string') {
      return null;
    }
    if (typeof data.isFinal !== 'boolean') {
      return null;
    }
    if (
      data.confidence !== undefined &&
      (!Number.isFinite(data.confidence) || data.confidence < 0)
    ) {
      return null;
    }
    return {
      rehearsalId: data.rehearsalId,
      transcript: data.transcript.trim(),
      confidence: data.confidence ?? 0,
      isInterim: !data.isFinal,
    };
  }
}
