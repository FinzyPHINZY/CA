// manages turn progression within a Hazel session.
// reads from the Redis-stored Turn[] sequence.
// emits Socket.io events for each turn type.
// handles: actor, hazel, action, parenthetical, scene_complete detection.

import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { LOOP_MAX_ITERATIONS, RehearsalEventType } from '@app/common';
import { HazelSessionService } from './hazel-session.service';
import { TurnSequenceBuilder } from './turn-sequence.builder';
import { HazelAudioPreGenerationService } from './hazel-audio-pregeneration.service';
import { HazelEventLoggerService } from './hazel-event-logger.service';
import type { Turn, HazelSessionState } from './types/hazel.types';

// 16KB strikes the right balance: large enough to amortize Socket.io's
// ~1ms per-emit overhead (a 200KB Hazel line goes from 50 emits to 13),
// small enough to keep frame sizes well under Socket.io's default limits.
const AUDIO_CHUNK_SIZE = 16 * 1024;

// If the client never sends hazel.playback.done, auto-advance after this timeout.
// Generous upper bound — covers long monologues + network lag.
const PLAYBACK_ACK_TIMEOUT_MS = 60_000;

@Injectable()
export class TurnSequencerService {
  private readonly logger = new Logger(TurnSequencerService.name);

  // in-memory map of active action/parenthetical timers (for pause/resume).
  private readonly pauseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  // in-memory map of playback ack safety timers (hazel turns).
  private readonly playbackAckTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly sessionService: HazelSessionService,
    private readonly sequenceBuilder: TurnSequenceBuilder,
    private readonly audioPregen: HazelAudioPreGenerationService,
    private readonly eventLogger: HazelEventLoggerService,
  ) {}

  /** Emit `line.index_changed` with the minimal turn identity. */
  async emitLineIndexChanged(
    rehearsalId: string,
    lineIndex: number,
    turn: Turn,
    server: Server,
  ): Promise<void> {
    server.to(rehearsalId).emit('line.index_changed', {
      lineIndex,
      type: turn.type,
      characterName: turn.characterName,
    });
  }

  // advance to the next turn. Core progression entry point.
  async advance(rehearsalId: string, server: Server): Promise<void> {
    const state = await this.sessionService.getSession(rehearsalId);

    if (state.status === 'paused' || state.status === 'ended') return;

    const nextIndex = state.currentLineIndex + 1;

    // scene complete check (4.1.36)
    if (nextIndex >= state.totalLines) {
      // loop mode wraparound — capped to avoid runaway sessions
      const loopMode = state.settings?.loopMode === true;
      const iteration = state.loopIteration ?? 0;
      if (loopMode && iteration < LOOP_MAX_ITERATIONS) {
        await this.sessionService.updateSession(rehearsalId, {
          loopIteration: iteration + 1,
        });
        server.to(rehearsalId).emit('session.loop', {
          iteration: iteration + 1,
          totalLines: state.totalLines,
        });
        this.logger.log(
          `Loop wraparound for ${rehearsalId} — iteration ${iteration + 1}`,
        );
        // jumpTo(0) restarts from the beginning of the sequence
        await this.jumpTo(rehearsalId, 0, server, false);
        return;
      }
      await this.emitSceneComplete(rehearsalId, state, server);
      return;
    }

    const turn = await this.sequenceBuilder.getTurn(rehearsalId, nextIndex);
    if (!turn) return;

    await this.sessionService.setCurrentTurn(rehearsalId, turn.type, nextIndex);

    await this.emitLineIndexChanged(rehearsalId, nextIndex, turn, server);

    await this.dispatchTurn(rehearsalId, turn, state, server);
  }

  // route to the correct turn handler based on type.
  async dispatchTurn(
    rehearsalId: string,
    turn: Turn,
    state: HazelSessionState,
    server: Server,
  ): Promise<void> {
    switch (turn.type) {
      case 'actor':
        await this.handleActorTurn(rehearsalId, turn, server);
        break;
      case 'hazel':
        await this.handleHazelTurn(rehearsalId, turn, state, server);
        break;
      case 'action':
        await this.handleActionTurn(rehearsalId, turn, server);
        break;
      case 'parenthetical':
        await this.handleParentheticalTurn(rehearsalId, turn, server);
        break;
    }
  }

  // actor turn. AUTO waits for the FE `turn.end` signal; LISTEN auto-paces;
  // MANUAL waits for `manual:advance`.
  async handleActorTurn(
    rehearsalId: string,
    turn: Turn,
    server: Server,
  ): Promise<void> {
    const state = await this.sessionService.getSession(rehearsalId);
    const detectionMode = state.settings?.detectionMode ?? 'AUTO';

    if (detectionMode === 'LISTEN') {
      await this.eventLogger.logTurnEvent(
        rehearsalId,
        RehearsalEventType.LINE_STARTED,
        turn,
        { mode: 'LISTEN' },
      );
      server.to(rehearsalId).emit('actor.turn', {
        lineIndex: turn.index,
        lines: turn.lines,
        characterName: turn.characterName,
        mode: 'LISTEN',
      });
      const wordCount = turn.text ? turn.text.trim().split(/\s+/).length : 1;
      const pacingMs = Math.max(1500, wordCount * 350);
      setTimeout(() => {
        void this.advance(rehearsalId, server).catch((err) => {
          this.logger.warn(
            `LISTEN auto-advance failed for ${rehearsalId}: ${err?.message ?? err}`,
          );
        });
      }, pacingMs);
      return;
    }

    // AUTO and MANUAL both emit and wait. AUTO advances on `turn.end`,
    // MANUAL on `manual:advance`.
    await this.sessionService.updateSession(rehearsalId, {
      actorTurnStartedAt: new Date().toISOString(),
    });
    await this.eventLogger.logTurnEvent(
      rehearsalId,
      RehearsalEventType.LINE_STARTED,
      turn,
      { mode: detectionMode },
    );
    server.to(rehearsalId).emit('actor.turn', {
      lineIndex: turn.index,
      lines: turn.lines,
      characterName: turn.characterName,
      mode: detectionMode,
    });
  }

  // hazel turn (4.1.32)
  async handleHazelTurn(
    rehearsalId: string,
    turn: Turn,
    state: HazelSessionState,
    server: Server,
  ): Promise<void> {
    // character change detection (4.1.35)
    if (
      turn.characterName &&
      turn.characterName !== state.previousHazelCharacterName
    ) {
      const voiceId = turn.characterId
        ? (state.voiceMap?.[turn.characterId] ?? null)
        : null;
      server.to(rehearsalId).emit('hazel.character_changed', {
        characterName: turn.characterName,
        voiceId,
      });
    }

    // Proactive voice-resolution check — surfaces mismapped turns in logs
    // (and as a dedicated event) before we hit the TTS pathway. Playback
    // still fails via handleHazelAudioFailure, but this gives ops a cleaner
    // signal that the cause was a missing voiceMap entry, not an ElevenLabs
    // outage.
    if (!turn.characterId || !state.voiceMap?.[turn.characterId]) {
      this.logger.warn(
        `Hazel turn ${turn.index} has no voice mapping ` +
          `(characterId="${turn.characterId ?? 'none'}", ` +
          `characterName="${turn.characterName ?? 'unknown'}") — ` +
          `voiceMap will be unable to resolve a voiceId`,
      );
      server.to(rehearsalId).emit('hazel.voice_missing', {
        lineIndex: turn.index,
        characterId: turn.characterId ?? null,
        characterName: turn.characterName ?? null,
      });
    }

    await this.sessionService.updateSession(rehearsalId, {
      isHazelSpeaking: true,
      lastHazelLineIndex: turn.index,
      previousHazelCharacterName: turn.characterName ?? null,
    });

    // Pull audio as an async stream. Cache hit → single full chunk (no
    // observable change). Cache miss → live-stream from ElevenLabs, first
    // chunk arriving in ~250ms instead of ~1500ms for the buffered path.
    let stream: AsyncIterable<Buffer>;
    try {
      stream = this.audioPregen.getAudioStreamForLine(
        rehearsalId,
        turn.index,
        turn,
      );
    } catch (err: any) {
      this.logger.error(
        `Audio retrieval failed for line ${turn.index}: ${err.message}`,
      );
      await this.handleHazelAudioFailure(rehearsalId, turn, err, server);
      return;
    }

    server
      .to(rehearsalId)
      .emit('hazel.speaking.start', { lineIndex: turn.index });

    try {
      for await (const buf of stream) {
        // re-chunk to AUDIO_CHUNK_SIZE so Socket.io frame sizes stay
        // predictable regardless of upstream chunk shape.
        for (let offset = 0; offset < buf.length; offset += AUDIO_CHUNK_SIZE) {
          const chunk = buf.subarray(offset, offset + AUDIO_CHUNK_SIZE);
          server.to(rehearsalId).emit('hazel.audio', chunk);
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Audio stream failed mid-playback for line ${turn.index}: ${err.message}`,
      );
      await this.handleHazelAudioFailure(rehearsalId, turn, err, server);
      return;
    }

    server
      .to(rehearsalId)
      .emit('hazel.speaking.end', { lineIndex: turn.index });

    await this.sessionService.updateSession(rehearsalId, {
      isHazelSpeaking: false,
    });

    await this.eventLogger.logTurnEvent(
      rehearsalId,
      RehearsalEventType.LINE_COMPLETED,
      turn,
    );

    // Wait for the client to confirm playback is done (hazel.playback.done)
    // before advancing. Set a safety timeout in case the client never acks.
    this.startPlaybackAckTimer(rehearsalId, server);
  }

  // Called by the gateway when client emits hazel.playback.done.
  async onPlaybackDone(rehearsalId: string, server: Server): Promise<void> {
    this.clearPlaybackAckTimer(rehearsalId);

    const state = await this.sessionService
      .getSession(rehearsalId)
      .catch(() => null);
    if (!state || state.status !== 'active') return;

    await this.advance(rehearsalId, server);
  }

  private startPlaybackAckTimer(rehearsalId: string, server: Server): void {
    this.clearPlaybackAckTimer(rehearsalId);

    const timer = setTimeout(async () => {
      this.playbackAckTimers.delete(rehearsalId);
      this.logger.warn(
        `Playback ack timeout for ${rehearsalId} — auto-advancing`,
      );
      const state = await this.sessionService
        .getSession(rehearsalId)
        .catch(() => null);
      if (state?.status === 'active') {
        await this.advance(rehearsalId, server);
      }
    }, PLAYBACK_ACK_TIMEOUT_MS);

    this.playbackAckTimers.set(rehearsalId, timer);
  }

  private clearPlaybackAckTimer(rehearsalId: string): void {
    const timer = this.playbackAckTimers.get(rehearsalId);
    if (timer) {
      clearTimeout(timer);
      this.playbackAckTimers.delete(rehearsalId);
    }
  }

  private async handleHazelAudioFailure(
    rehearsalId: string,
    turn: Turn,
    err: Error,
    server: Server,
  ): Promise<void> {
    await this.sessionService.updateSession(rehearsalId, {
      isHazelSpeaking: false,
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });
    await this.sessionService.markPaused(rehearsalId);

    await this.eventLogger.log(rehearsalId, RehearsalEventType.PAUSE, {
      lineIndex: turn.index,
      characterId: turn.characterId,
      currentTurn: 'hazel',
      reason: 'hazel_audio_failure',
      errorMessage: err.message,
    });

    server.to(rehearsalId).emit('hazel.audio_failed', {
      lineIndex: turn.index,
      characterId: turn.characterId,
      characterName: turn.characterName,
      recoverable: true,
      message: 'Hazel audio playback failed for this line',
    });
    server.to(rehearsalId).emit('session.paused', {
      rehearsalId,
      reason: 'hazel_audio_failure',
      lineIndex: turn.index,
    });
  }

  // action turn (4.1.33)
  async handleActionTurn(
    rehearsalId: string,
    turn: Turn,
    server: Server,
  ): Promise<void> {
    server.to(rehearsalId).emit('action.display', {
      text: turn.text,
      lineIndex: turn.index,
    });

    const timer = setTimeout(async () => {
      this.pauseTimers.delete(rehearsalId);
      const session = await this.sessionService
        .getSession(rehearsalId)
        .catch(() => null);
      if (session?.status === 'active') {
        await this.advance(rehearsalId, server);
      }
    }, turn.pauseMs ?? 2000);

    this.pauseTimers.set(rehearsalId, timer);
  }

  // parenthetical turn (4.1.34)
  async handleParentheticalTurn(
    rehearsalId: string,
    turn: Turn,
    server: Server,
  ): Promise<void> {
    server.to(rehearsalId).emit('parenthetical.display', {
      text: turn.text,
      lineIndex: turn.index,
    });

    const timer = setTimeout(async () => {
      this.pauseTimers.delete(rehearsalId);
      const session = await this.sessionService
        .getSession(rehearsalId)
        .catch(() => null);
      if (session?.status === 'active') {
        await this.advance(rehearsalId, server);
      }
    }, turn.pauseMs ?? 800);

    this.pauseTimers.set(rehearsalId, timer);
  }

  // scene complete (4.1.36)
  private async emitSceneComplete(
    rehearsalId: string,
    state: HazelSessionState,
    server: Server,
  ): Promise<void> {
    const sessionDurationMs = Date.now() - new Date(state.startedAt).getTime();
    server.to(rehearsalId).emit('session.scene_complete', {
      totalLines: state.totalLines,
      sessionDurationMs,
    });
    this.logger.log(`Scene complete for ${rehearsalId}`);
  }

  // jumpTo (4.1.40)
  async jumpTo(
    rehearsalId: string,
    lineIndex: number,
    server: Server,
    logSkippedActorLines = true,
  ): Promise<void> {
    const state = await this.sessionService.getSession(rehearsalId);
    const sequence = await this.sequenceBuilder.getSequence(rehearsalId);

    if (lineIndex < 0 || lineIndex >= state.totalLines) return;

    // log skipped actor turns if jumping forward
    if (logSkippedActorLines && lineIndex > state.currentLineIndex) {
      for (let i = state.currentLineIndex + 1; i < lineIndex; i++) {
        const t = sequence[i];
        if (t?.type === 'actor') {
          await this.eventLogger.log(
            rehearsalId,
            RehearsalEventType.LINE_SKIPPED,
            {
              lineIndex: i,
              characterId: t.characterId,
            },
          );
        }
      }
    }

    this.cancelPauseTimer(rehearsalId);

    const turn = sequence[lineIndex];
    if (!turn) return;

    await this.sessionService.setCurrentTurn(rehearsalId, turn.type, lineIndex);

    await this.emitLineIndexChanged(rehearsalId, lineIndex, turn, server);

    await this.dispatchTurn(rehearsalId, turn, state, server);
  }

  // pause/resume helpers
  cancelPauseTimer(rehearsalId: string): void {
    const timer = this.pauseTimers.get(rehearsalId);
    if (timer) {
      clearTimeout(timer);
      this.pauseTimers.delete(rehearsalId);
    }
  }

  cleanup(rehearsalId: string): void {
    this.cancelPauseTimer(rehearsalId);
    this.clearPlaybackAckTimer(rehearsalId);
  }
}
