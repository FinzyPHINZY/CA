// Authentication: JWT in socket.handshake.auth.token validated via auth_service TCP. each socket joins the room named `rehearsalId` so events are scoped per session.
// Events received: session.start, session.end, session.pause, session.resume, cue.skip, manual:advance, session.jump_to, hazel.playback.done
// Events emitted: session.started, session.paused, session.resumed, session.ended, line.index_changed, hazel.speaking.start, hazel.speaking.end, hazel.audio, hazel.audio_failed, error
//
// Turn advancement under the redesign is driven by the frontend turn-detection
// model, which emits a `turn.end` event (handled separately). The gateway no
// longer performs server-side word-matching / cue detection on transcripts.

// biome-ignore-all lint/suspicious/noExplicitAny: <>
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

import { HazelSessionService } from './hazel-session.service';
import { TurnSequencerService } from './turn-sequencer.service';
import { HazelEventLoggerService } from './hazel-event-logger.service';
import { HazelAudioPreGenerationService } from './hazel-audio-pregeneration.service';
import { HazelRecordingService } from './hazel-recording.service';
import { TurnSequenceBuilder } from './turn-sequence.builder';
import { DeepgramService } from '../cue-engine/deepgram.service';
import { contentWordCount, contentWordOverlap } from './word-overlap.util';

// Below this content-word overlap, a turn.end transcript is flagged as a
// likely wrong-line read (advisory only — never blocks advance).
const MISMATCH_OVERLAP_THRESHOLD = 0.15;
// The wrong-line check only runs when BOTH sides carry enough signal to trust.
// Short expected lines make overlap binary/noisy (one STT slip flips 0↔1);
// a thin transcript means STT dropped or returned a partial. In either case we
// can't tell "wrong line" from "no signal", so we skip the advisory entirely.
const MISMATCH_MIN_EXPECTED_WORDS = 4;
const MISMATCH_MIN_TRANSCRIPT_WORDS = 3;

@WebSocketGateway({
  namespace: '/hazel',
  cors: { origin: '*', credentials: true },
})
export class HazelSessionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;

  private readonly logger = new Logger(HazelSessionGateway.name);

  /** socket.id → { userId, rehearsalId } */
  private readonly socketMap = new Map<
    string,
    { userId: string; rehearsalId: string | null }
  >();

  constructor(
    @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
    private readonly sessionService: HazelSessionService,
    private readonly sequencer: TurnSequencerService,
    private readonly eventLogger: HazelEventLoggerService,
    private readonly audioPregen: HazelAudioPreGenerationService,
    private readonly sequenceBuilder: TurnSequenceBuilder,
    private readonly hazelRecording: HazelRecordingService,
    private readonly deepgramService: DeepgramService,
  ) {}

  // connection lifecycle
  async handleConnection(socket: Socket): Promise<void> {
    try {
      const token = socket.handshake.auth?.token as string;
      if (!token) {
        this.logger.warn(`Connection rejected (no token): ${socket.id}`);
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
      await this.sessionService
        .markSocketDisconnected(meta.rehearsalId)
        .catch(() => null);
      this.logger.log(
        `WS disconnected: ${socket.id} (rehearsal=${meta.rehearsalId})`,
      );
    }
  }

  // session.start
  @SubscribeMessage('session.start')
  async onSessionStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string; recordSession?: boolean },
  ): Promise<void> {
    const userId = (socket as any).userId as string;
    const { rehearsalId, recordSession } = data;

    try {
      const state = await this.sessionService.getSession(rehearsalId);

      if (state.userId !== userId) {
        socket.emit('error', {
          code: 'FORBIDDEN',
          message: 'Not your session',
        });
        return;
      }

      if (state.status !== 'ready' && state.status !== 'preparing') {
        socket.emit('error', {
          code: 'INVALID_STATE',
          message: `Session is ${state.status}`,
        });
        return;
      }

      socket.join(rehearsalId);
      const meta = this.socketMap.get(socket.id);
      if (meta) meta.rehearsalId = rehearsalId;

      const sequence = await this.sequenceBuilder.getSequence(rehearsalId);
      const firstTurn = sequence[0];

      if (!firstTurn) {
        socket.emit('error', {
          code: 'EMPTY_SEQUENCE',
          message: 'No turns in sequence',
        });
        return;
      }

      // freeze + push frozen settings before deciding recording so settings.autoRecord
      // is the authoritative gate (overrides client-provided recordSession).
      const frozenSettings = await this.sessionService
        .resolveAndPushSettings(rehearsalId)
        .catch(() => null);

      // tag all subsequent events with detection mode for analytics
      if (frozenSettings) {
        this.eventLogger.setSessionMode(
          rehearsalId,
          frozenSettings.detectionMode,
        );
      }

      // settings.autoRecord defaults to true. Client `recordSession` is used only if
      // the resolved settings are unavailable (defensive fallback).
      const shouldRecord = frozenSettings
        ? frozenSettings.autoRecord
        : (recordSession ?? true);
      const recordingChannelName = shouldRecord
        ? `hazel_rec_${rehearsalId}`
        : null;

      await this.sessionService.updateSession(rehearsalId, {
        status: 'active',
        recordingChannelName,
        lastSocketDisconnectAt: null,
      });
      await this.sessionService.markActive(rehearsalId);

      // kick off optional Agora cloud recording (fire-and-forget;
      // recording failure must not abort the rehearsal session itself).
      if (shouldRecord && recordingChannelName) {
        this.hazelRecording
          .startRecording(rehearsalId, recordingChannelName, userId)
          .catch((err: Error) =>
            this.logger.error(
              `Agora recording start failed (rehearsal=${rehearsalId}): ${err.message}`,
            ),
          );
      }

      socket.emit('session.started', {
        rehearsalId,
        totalLines: state.totalLines,
        recordingChannelName,
      });

      await this.sessionService.setCurrentTurn(rehearsalId, firstTurn.type, 0);
      await this.sequencer.emitLineIndexChanged(
        rehearsalId,
        0,
        firstTurn,
        this.server,
      );

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

  // session.end
  @SubscribeMessage('session.end')
  async onSessionEnd(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const userId = (socket as any).userId as string;
    const { rehearsalId } = data;

    try {
      const state = await this.sessionService.getSession(rehearsalId);
      if (state.userId !== userId) return;

      this.sequencer.cleanup(rehearsalId);

      if (state.deepgramKeyId) {
        await this.deepgramService.revokeKey(state.deepgramKeyId);
      }

      // ask core to finalize Agora recording (emit-only; core owns the stop
      // call so it can write the Recording row + Media rows + notify the user
      // atomically with the Agora response).
      if (state.recordingChannelName) {
        this.hazelRecording
          .requestStop(rehearsalId)
          .catch((err: Error) =>
            this.logger.error(
              `Hazel recording stop emit failed (rehearsal=${rehearsalId}): ${err.message}`,
            ),
          );
      }

      if (state.status === 'active' || state.status === 'paused') {
        await this.sessionService.endSession(rehearsalId);
      } else {
        await this.sessionService.forceResetSession(rehearsalId, userId);
      }

      await this.eventLogger.flushSession(rehearsalId);

      this.server.to(rehearsalId).emit('session.ended', { rehearsalId });
      socket.leave(rehearsalId);
    } catch (err: any) {
      this.logger.error(`session.end error: ${err.message}`);
    }
  }

  // session.pause
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

  // session.resume
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

    // re-dispatch the current turn (restores timers for action/parenthetical)
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

  // cue.skip — actor taps "next" to escape a stuck or unwanted line.
  // Works in any detection mode (not gated like manual:advance).
  // Returns a Socket.io ack so the client can show toast feedback on
  // rejection (paused session, Hazel turn, etc.) instead of guessing
  // from the absence of follow-up events.
  @SubscribeMessage('cue.skip')
  async onCueSkip(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<{
    skipped: boolean;
    reason?: 'invalid_session' | 'not_active' | 'not_actor_turn';
  }> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state) {
      return { skipped: false, reason: 'invalid_session' };
    }
    if (state.status !== 'active') {
      return { skipped: false, reason: 'not_active' };
    }
    if (state.currentTurn !== 'actor') {
      return { skipped: false, reason: 'not_actor_turn' };
    }

    const turn = await this.sequenceBuilder.getTurn(
      data.rehearsalId,
      state.currentLineIndex,
    );
    this.sequencer.cancelPauseTimer(data.rehearsalId);

    await this.eventLogger.logTurnEvent(
      data.rehearsalId,
      RehearsalEventType.LINE_SKIPPED,
      turn,
      { lineIndex: state.currentLineIndex },
    );

    await this.sequencer.advance(data.rehearsalId, this.server);
    return { skipped: true };
  }

  // manual:advance — used in MANUAL detection mode (tap button / spacebar).
  // No-op for other modes to prevent accidental advance.
  @SubscribeMessage('manual:advance')
  async onManualAdvance(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state || state.status !== 'active') return;
    if (state.currentTurn !== 'actor') return;

    const detectionMode = state.settings?.detectionMode ?? 'AUTO';
    if (detectionMode !== 'MANUAL') return;

    const turn = await this.sequenceBuilder.getTurn(
      data.rehearsalId,
      state.currentLineIndex,
    );

    await this.eventLogger.logTurnEvent(
      data.rehearsalId,
      RehearsalEventType.LINE_COMPLETED,
      turn,
      { lineIndex: state.currentLineIndex, triggerType: 'manual_advance' },
    );

    await this.sequencer.advance(data.rehearsalId, this.server);
  }

  // hazel.playback.done — client confirms it finished playing Hazel audio
  @SubscribeMessage('hazel.playback.done')
  async onPlaybackDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string },
  ): Promise<void> {
    try {
      const state = await this.sessionService
        .getSession(data.rehearsalId)
        .catch(() => null);
      if (!state || state.userId !== (socket as any).userId) return;
      if (state.status !== 'active') return;

      await this.sequencer.onPlaybackDone(data.rehearsalId, this.server);
    } catch (err: any) {
      this.logger.error(`hazel.playback.done error: ${err.message}`);
    }
  }

  // turn.end — FE turn-detection model says the actor finished their line.
  // The single advance trigger for AUTO mode.
  @SubscribeMessage('turn.end')
  async onTurnEnd(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { rehearsalId: string; lineIndex: number; transcript?: string },
  ): Promise<void> {
    try {
      const { rehearsalId, lineIndex } = data;
      const transcript = data.transcript ?? '';
      const state = await this.sessionService.getSession(rehearsalId);

      if (state.userId !== (socket as any).userId) return;
      if (state.status !== 'active') return;
      if (state.currentTurn !== 'actor') return;
      if ((state.settings?.detectionMode ?? 'AUTO') !== 'AUTO') return;
      if (lineIndex !== state.currentLineIndex) return; // stale / duplicate

      const turn = await this.sequenceBuilder.getTurn(rehearsalId, lineIndex);
      if (!turn || turn.type !== 'actor') return;

      // Advisory wrong-line guard — only when wordTracking is enabled. Never
      // blocks: we emit a hint and advance regardless. Only judged when both
      // the expected line and the transcript carry enough content words to be
      // trustworthy (see MISMATCH_MIN_* — short lines / thin transcripts are
      // un-judgeable and would false-flag, so they are skipped).
      if (state.settings?.wordTracking === true) {
        const expected = turn.lines.join(' ');
        const judgeable =
          contentWordCount(expected) >= MISMATCH_MIN_EXPECTED_WORDS &&
          contentWordCount(transcript) >= MISMATCH_MIN_TRANSCRIPT_WORDS;
        if (judgeable) {
          const overlap = contentWordOverlap(transcript, expected);
          if (overlap < MISMATCH_OVERLAP_THRESHOLD) {
            this.server
              .to(rehearsalId)
              .emit('actor.line_mismatch', { lineIndex, overlap });
            await this.eventLogger.logTurnEvent(
              rehearsalId,
              RehearsalEventType.LINE_MISMATCH,
              turn,
              { overlap, transcript },
            );
          }
        }
      }

      const responseTimeMs = state.actorTurnStartedAt
        ? Date.now() - Date.parse(state.actorTurnStartedAt)
        : undefined;

      await this.eventLogger.logTurnEvent(
        rehearsalId,
        RehearsalEventType.LINE_COMPLETED,
        turn,
        { transcript, trigger: 'turn_end', responseTimeMs },
      );

      await this.sequencer.advance(rehearsalId, this.server);
    } catch (err: any) {
      this.logger.error(`turn.end error: ${err.message}`);
    }
  }

  // session.jump_to
  @SubscribeMessage('session.jump_to')
  async onJumpTo(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { rehearsalId: string; lineIndex: number },
  ): Promise<void> {
    const state = await this.sessionService
      .getSession(data.rehearsalId)
      .catch(() => null);
    if (!state) return;

    this.sequencer.cancelPauseTimer(data.rehearsalId);

    await this.sequencer.jumpTo(
      data.rehearsalId,
      data.lineIndex,
      this.server,
      true,
    );
  }
}
