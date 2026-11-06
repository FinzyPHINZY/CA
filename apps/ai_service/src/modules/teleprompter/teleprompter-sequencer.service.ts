// TeleprompterSequencerService — manages turn progression and emits
// Socket.io events for the teleprompter session. Mirrors the shape of
// Hazel's TurnSequencerService but drops everything TTS-related.
//
// Turn kinds:
//   - 'line'          → emit `line.next`, await speech or manual advance
//   - 'action'        → emit `action.display`, auto-advance after pauseMs
//   - 'parenthetical' → emit `parenthetical.display`, auto-advance after pauseMs

import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { RehearsalEventType } from '@app/common';
import { CursorStateService } from '../cue-engine/cursor-state.service';
import { DeepgramService } from '../cue-engine/deepgram.service';
import { TeleprompterEventLoggerService } from './teleprompter-event-logger.service';
import { TeleprompterSequenceBuilder } from './teleprompter-sequence.builder';
import { TeleprompterSessionService } from './teleprompter-session.service';
import { SilenceDetectionService } from '../cue-engine/silence-detection.service';
import type {
  TeleprompterSessionState,
  TeleprompterTurn,
} from './types/teleprompter.types';

// Speakable turn kind for cue-engine integration (must match what
// TeleprompterSequenceBuilder passes to CursorStateService.buildSceneIndex).
const SPEAKABLE_KIND = 'line';

@Injectable()
export class TeleprompterSequencerService {
  private readonly logger = new Logger(TeleprompterSequencerService.name);

  // per-rehearsal action/parenthetical auto-advance timer.
  private readonly pauseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly sessionService: TeleprompterSessionService,
    private readonly sequenceBuilder: TeleprompterSequenceBuilder,
    private readonly eventLogger: TeleprompterEventLoggerService,
    private readonly silenceDetection: SilenceDetectionService,
    private readonly cursorStateService: CursorStateService,
    private readonly deepgramService: DeepgramService,
  ) {}

  /** Compute the Deepgram keyword window for a given line index. */
  async getKeywordsForLine(
    rehearsalId: string,
    lineIndex: number,
  ): Promise<string[]> {
    try {
      const sequence = await this.sequenceBuilder.getSequence(rehearsalId);
      if (!sequence?.length) return [];
      return this.deepgramService.buildKeywordWindow(
        sequence.map((t) => ({
          index: t.index,
          type: t.kind,
          text: t.text,
          lines: t.lines,
          characterName: t.characterName,
          characterId: t.characterId,
        })),
        lineIndex,
        1,
        3.0,
        1.5,
        SPEAKABLE_KIND,
      );
    } catch (err: any) {
      this.logger.warn(
        `getKeywordsForLine failed for ${rehearsalId}@${lineIndex}: ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Emit `line.index_changed` for a turn. Single choke point for every
   * cursor move (advance, jumpTo, session start). Includes Deepgram
   * keyword reconnect suppression — when the next keyword set is
   * substantially similar to the last one we emitted, FE keeps its
   * Deepgram socket open instead of reconnecting.
   */
  async emitLineIndexChanged(
    rehearsalId: string,
    lineIndex: number,
    turn: TeleprompterTurn,
    server: Server,
  ): Promise<void> {
    const nextKeywords = await this.getKeywordsForLine(rehearsalId, lineIndex);
    const state = await this.sessionService.getSession(rehearsalId);
    const shouldReconnect =
      this.deepgramService.shouldReconnectForKeywordChange(
        state.lastEmittedKeywords,
        nextKeywords,
      );

    if (shouldReconnect) {
      const payload: Record<string, unknown> = {
        lineIndex,
        kind: turn.kind,
        characterName: turn.characterName,
        deepgramModel: this.deepgramService.model,
        deepgramKeywords: nextKeywords,
      };
      if (this.deepgramService.usesKeyterm) {
        payload.deepgramKeyterms = nextKeywords.map((kw) => {
          const idx = kw.indexOf(':');
          return idx >= 0 ? kw.slice(0, idx) : kw;
        });
      }
      server.to(rehearsalId).emit('line.index_changed', payload);
      await this.sessionService.updateSession(rehearsalId, {
        lastEmittedKeywords: nextKeywords,
      });
    } else {
      server.to(rehearsalId).emit('line.index_changed', {
        lineIndex,
        kind: turn.kind,
        characterName: turn.characterName,
        deepgramModel: this.deepgramService.model,
        keywordsUnchanged: true,
      });
    }
  }

  /** Advance to the next turn. Core progression entry point. */
  async advance(rehearsalId: string, server: Server): Promise<void> {
    const state = await this.sessionService.getSession(rehearsalId);
    if (state.status === 'paused' || state.status === 'ended') return;

    const nextIndex = state.currentLineIndex + 1;

    if (nextIndex >= state.totalLines) {
      await this.emitSceneComplete(rehearsalId, state, server);
      return;
    }

    const turn = await this.sequenceBuilder.getTurn(rehearsalId, nextIndex);
    if (!turn) return;

    await this.sessionService.setCurrentTurn(rehearsalId, turn.kind, nextIndex);
    await this.emitLineIndexChanged(rehearsalId, nextIndex, turn, server);
    await this.dispatchTurn(rehearsalId, turn, state, server);
  }

  /** Route to the correct turn handler based on kind. */
  async dispatchTurn(
    rehearsalId: string,
    turn: TeleprompterTurn,
    state: TeleprompterSessionState,
    server: Server,
  ): Promise<void> {
    switch (turn.kind) {
      case 'line':
        await this.handleLineTurn(rehearsalId, turn, state, server);
        break;
      case 'action':
        await this.handleActionTurn(rehearsalId, turn, server);
        break;
      case 'parenthetical':
        await this.handleParentheticalTurn(rehearsalId, turn, server);
        break;
    }
  }

  private async handleLineTurn(
    rehearsalId: string,
    turn: TeleprompterTurn,
    state: TeleprompterSessionState,
    server: Server,
  ): Promise<void> {
    const detectionMode = state.settings?.detectionMode ?? 'AUTO';

    // For AUTO mode, prime the silence detector and reset the cursor for
    // this turn. MANUAL bypasses both — FE drives advance via manual:advance.
    if (detectionMode === 'AUTO') {
      const wordCount = turn.text
        ? turn.text
            .trim()
            .split(/\s+/)
            .filter((w) => w.length > 0).length
        : 0;
      this.silenceDetection.onActorTurnStart(rehearsalId, {
        wordCount,
        lineBucket:
          wordCount <= 3 ? 'short' : wordCount <= 7 ? 'medium' : 'long',
        silencePace: state.settings?.silencePace ?? 'normal',
      });
      await this.cursorStateService.resetForNewTurn(rehearsalId, turn.index);
    }

    await this.eventLogger.logTurnEvent(
      rehearsalId,
      RehearsalEventType.LINE_STARTED,
      turn,
      { mode: detectionMode },
    );

    server.to(rehearsalId).emit('line.next', {
      lineIndex: turn.index,
      lines: turn.lines,
      characterName: turn.characterName,
      mode: detectionMode,
    });
  }

  private async handleActionTurn(
    rehearsalId: string,
    turn: TeleprompterTurn,
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

  private async handleParentheticalTurn(
    rehearsalId: string,
    turn: TeleprompterTurn,
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

  private async emitSceneComplete(
    rehearsalId: string,
    state: TeleprompterSessionState,
    server: Server,
  ): Promise<void> {
    const sessionDurationMs = Date.now() - new Date(state.startedAt).getTime();
    server.to(rehearsalId).emit('session.scene_complete', {
      totalLines: state.totalLines,
      sessionDurationMs,
    });
    this.logger.log(`Teleprompter scene complete for ${rehearsalId}`);
  }

  /**
   * Jump to an arbitrary line index. Used by `session.jump_to` and `cue.back`.
   * `logSkippedLines` controls whether jumped-past lines are logged as skipped
   * (true for forward user-initiated jumps; false for cue.back rewinds).
   */
  async jumpTo(
    rehearsalId: string,
    lineIndex: number,
    server: Server,
    logSkippedLines = true,
  ): Promise<void> {
    const state = await this.sessionService.getSession(rehearsalId);
    const sequence = await this.sequenceBuilder.getSequence(rehearsalId);

    if (lineIndex < 0 || lineIndex >= state.totalLines) return;

    if (logSkippedLines && lineIndex > state.currentLineIndex) {
      for (let i = state.currentLineIndex + 1; i < lineIndex; i++) {
        const t = sequence[i];
        if (t?.kind === 'line') {
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
    this.silenceDetection.clearTimer(rehearsalId);

    const turn = sequence[lineIndex];
    if (!turn) return;

    await this.sessionService.setCurrentTurn(rehearsalId, turn.kind, lineIndex);
    await this.emitLineIndexChanged(rehearsalId, lineIndex, turn, server);
    await this.dispatchTurn(rehearsalId, turn, state, server);
  }

  cancelPauseTimer(rehearsalId: string): void {
    const timer = this.pauseTimers.get(rehearsalId);
    if (timer) {
      clearTimeout(timer);
      this.pauseTimers.delete(rehearsalId);
    }
  }

  cleanup(rehearsalId: string): void {
    this.cancelPauseTimer(rehearsalId);
    this.silenceDetection.cleanup(rehearsalId);
    this.cursorStateService.cleanup(rehearsalId);
  }
}
