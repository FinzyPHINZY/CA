// silence detection service (tasks 4.1.28, 4.1.29).
// per-session silence tracking. Emits advance signal after actor-appropriate
// silence, but only when the actor has clearly progressed far enough through
// the current line that silence is a reasonable completion signal.
//
// Two timers:
//   1. Silence timer (5s default) — fires when the actor stops speaking entirely
//   2. Stale match timer (2s) — fires when matchRatio >= threshold but hasn't
//      improved, meaning the actor has said enough and stopped progressing.
//      Prevents the session from feeling "stuck" on partial matches.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SILENCE_PACE_MULTIPLIERS, SilencePace } from '@app/common';
import type { LineBucket, SilenceState } from './types/cue-engine.types';

@Injectable()
export class SilenceDetectionService {
  private readonly logger = new Logger(SilenceDetectionService.name);
  private readonly baseSilenceMs: number;
  private readonly minSilenceMatchRatio: number;
  private readonly baseStaleMs: number;
  private readonly staleMatchMinRatio: number;
  private readonly perWordMs: number;
  private readonly maxSilenceMs: number;
  private readonly maxStaleMs: number;

  // map of rehearsalId → per-session silence state (in-memory).
  private readonly sessions = new Map<string, SilenceState>();

  constructor(private readonly configService: ConfigService) {
    this.baseSilenceMs = this.configService.get<number>(
      'HAZEL_SILENCE_THRESHOLD_MS',
      2500,
    );
    // lowered from 0.6 to 0.4 — with fuzzy matching, ratios are more reliable
    this.minSilenceMatchRatio = this.configService.get<number>(
      'HAZEL_SILENCE_MIN_MATCH_RATIO',
      0.4,
    );
    // stale match: if matchRatio hasn't improved for this long, auto-advance
    this.baseStaleMs = this.configService.get<number>(
      'HAZEL_STALE_MATCH_THRESHOLD_MS',
      1200,
    );
    // minimum match ratio for stale match to trigger (lower than silence since
    // the actor clearly made an attempt)
    this.staleMatchMinRatio = this.configService.get<number>(
      'HAZEL_STALE_MATCH_MIN_RATIO',
      0.35,
    );
    // ms added per word in the actor's line for dynamic scaling.
    // ~150ms/word ≈ average reading pace, gives breathing room on long lines.
    this.perWordMs = this.configService.get<number>(
      'HAZEL_SILENCE_PER_WORD_MS',
      150,
    );
    // upper bounds so a very long monologue doesn't wait forever
    this.maxSilenceMs = this.configService.get<number>(
      'HAZEL_SILENCE_MAX_MS',
      15000,
    );
    this.maxStaleMs = this.configService.get<number>(
      'HAZEL_STALE_MAX_MS',
      8000,
    );
  }

  // called when an actor turn begins — resets all state for this turn.
  // wordCount allows dynamic scaling of silence/stale thresholds.
  onActorTurnStart(
    rehearsalId: string,
    metadata: {
      wordCount?: number;
      lineBucket?: LineBucket;
      silencePace?: SilencePace;
    } = {},
  ): void {
    this.clearTimers(rehearsalId);
    const wordCount = metadata.wordCount ?? 0;
    const lineBucket = metadata.lineBucket ?? 'short';
    const silencePace = metadata.silencePace ?? 'normal';

    const { silenceMs, staleMs } = this.computeThresholds(
      wordCount,
      silencePace,
    );

    this.logger.debug(
      `Actor turn start for ${rehearsalId}: ${wordCount} words, pace=${silencePace} → silence=${silenceMs}ms, stale=${staleMs}ms`,
    );

    this.sessions.set(rehearsalId, {
      lastTranscriptAt: 0,
      lastMatchRatio: 0,
      actorStarted: false,
      actorTurnStartedAt: Date.now(),
      silenceTimer: null,
      staleMatchTimer: null,
      lastAccumulatedTranscript: '',
      lastTranscriptWasFinal: false,
      highWaterMatchRatio: 0,
      highWaterMatchAt: 0,
      dynamicSilenceMs: silenceMs,
      dynamicStaleMs: staleMs,
      lineBucket,
      totalContentWords: wordCount,
      tailCoverage: false,
    });
  }

  // compute per-turn thresholds scaled by word count and user pace preference.
  // short lines (≤10 words) use base values; longer lines scale up.
  // pace multiplier (fast=0.6, normal=1.0, patient=1.6) applied last.
  private computeThresholds(
    wordCount: number,
    silencePace: SilencePace = 'normal',
  ): {
    silenceMs: number;
    staleMs: number;
  } {
    const extraWords = Math.max(0, wordCount - 10);
    const multiplier = SILENCE_PACE_MULTIPLIERS[silencePace];
    const silenceMs = Math.min(
      (this.baseSilenceMs + extraWords * this.perWordMs) * multiplier,
      this.maxSilenceMs,
    );
    const staleMs = Math.min(
      (this.baseStaleMs + extraWords * this.perWordMs) * multiplier,
      this.maxStaleMs,
    );
    return { silenceMs, staleMs };
  }

  // called on every transcript received for this session.
  // returns the actor turn start time (for responseTimeMs computation).
  onTranscriptReceived(
    rehearsalId: string,
    matchRatio: number,
    accumulatedTranscript: string,
    isFinal: boolean,
    tailCoverage: boolean,
    onSilenceAdvance: () => void,
  ): {
    actorTurnStartedAt: number;
    readiness: {
      actorStarted: boolean;
      accumulatedWordCount: number;
      matchRatio: number;
      transcriptWasFinal: boolean;
      silenceThresholdMs: number;
      minMatchRatio: number;
      lineBucket: LineBucket;
      tailCoverage: boolean;
    };
  } {
    let state = this.sessions.get(rehearsalId);
    if (!state) {
      state = {
        lastTranscriptAt: Date.now(),
        lastMatchRatio: matchRatio,
        actorStarted: false,
        actorTurnStartedAt: Date.now(),
        silenceTimer: null,
        staleMatchTimer: null,
        lastAccumulatedTranscript: '',
        lastTranscriptWasFinal: false,
        highWaterMatchRatio: 0,
        highWaterMatchAt: 0,
        dynamicSilenceMs: this.baseSilenceMs,
        dynamicStaleMs: this.baseStaleMs,
        lineBucket: 'short',
        totalContentWords: 0,
        tailCoverage: false,
      };
      this.sessions.set(rehearsalId, state);
    }

    state.lastTranscriptAt = Date.now();
    state.lastMatchRatio = matchRatio;
    state.lastAccumulatedTranscript = accumulatedTranscript.trim();
    state.lastTranscriptWasFinal = isFinal;
    state.tailCoverage = tailCoverage;

    // mark actor as started if any meaningful match (4.1.29)
    if (matchRatio > 0 && state.lastAccumulatedTranscript.length > 0) {
      state.actorStarted = true;
    }

    // track high-water match ratio for stale detection
    if (matchRatio > state.highWaterMatchRatio) {
      state.highWaterMatchRatio = matchRatio;
      state.highWaterMatchAt = Date.now();
    }

    // reset silence timer
    this.clearTimers(rehearsalId);

    // Timer 1: silence advance — fires after no new transcripts for N seconds
    // Uses per-turn dynamic threshold scaled by line word count.
    state.silenceTimer = setTimeout(() => {
      const s = this.sessions.get(rehearsalId);
      if (
        s?.actorStarted &&
        this.isReadyForSilenceAdvance(
          s.lastMatchRatio,
          s.lastAccumulatedTranscript,
          s.lastTranscriptWasFinal,
          s.lineBucket,
          s.tailCoverage,
        )
      ) {
        this.logger.debug(
          `Silence advance fired for ${rehearsalId} (matchRatio=${s.lastMatchRatio.toFixed(2)}, ` +
            `final=${s.lastTranscriptWasFinal}, words=${this.countWords(s.lastAccumulatedTranscript)}, ` +
            `threshold=${state.dynamicSilenceMs}ms)`,
        );
        onSilenceAdvance();
      }
    }, state.dynamicSilenceMs);

    // Timer 2: stale match advance — fires when matchRatio >= threshold but
    // hasn't improved, meaning the actor finished their attempt. Shorter than
    // the silence timer so the session doesn't feel stuck.
    // Uses per-turn dynamic threshold scaled by line word count.
    if (
      state.actorStarted &&
      this.shouldScheduleStaleMatch(state.lineBucket, matchRatio, tailCoverage)
    ) {
      state.staleMatchTimer = setTimeout(() => {
        const s = this.sessions.get(rehearsalId);
        if (!s?.actorStarted) return;

        // only fire if the match ratio hasn't improved since we set this timer
        if (
          s.lastMatchRatio >= this.staleMatchMinRatio &&
          s.highWaterMatchRatio <= matchRatio + 0.05
        ) {
          this.logger.debug(
            `Stale match advance fired for ${rehearsalId} (matchRatio=${s.lastMatchRatio.toFixed(2)}, ` +
              `staleDuration=${state.dynamicStaleMs}ms, words=${this.countWords(s.lastAccumulatedTranscript)})`,
          );
          onSilenceAdvance();
        }
      }, state.dynamicStaleMs);
    }

    return {
      actorTurnStartedAt: state.actorTurnStartedAt,
      readiness: {
        actorStarted: state.actorStarted,
        accumulatedWordCount: this.countWords(state.lastAccumulatedTranscript),
        matchRatio: state.lastMatchRatio,
        transcriptWasFinal: state.lastTranscriptWasFinal,
        silenceThresholdMs: state.dynamicSilenceMs,
        minMatchRatio: this.minSilenceMatchRatio,
        lineBucket: state.lineBucket,
        tailCoverage: state.tailCoverage,
      },
    };
  }

  // cancel all timers for a session. called on pause or session end.
  clearTimer(rehearsalId: string): void {
    this.clearTimers(rehearsalId);
  }

  getActorTurnStartedAt(rehearsalId: string): number {
    return this.sessions.get(rehearsalId)?.actorTurnStartedAt ?? Date.now();
  }

  cleanup(rehearsalId: string): void {
    this.clearTimers(rehearsalId);
    this.sessions.delete(rehearsalId);
  }

  private clearTimers(rehearsalId: string): void {
    const state = this.sessions.get(rehearsalId);
    if (state?.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    if (state?.staleMatchTimer) {
      clearTimeout(state.staleMatchTimer);
      state.staleMatchTimer = null;
    }
  }

  private isReadyForSilenceAdvance(
    matchRatio: number,
    accumulatedTranscript: string,
    transcriptWasFinal: boolean,
    lineBucket: LineBucket,
    tailCoverage: boolean,
  ): boolean {
    const requiredMatchRatio =
      lineBucket === 'long'
        ? Math.max(this.minSilenceMatchRatio, 0.8)
        : lineBucket === 'medium'
          ? Math.max(this.minSilenceMatchRatio, 0.7)
          : this.minSilenceMatchRatio;

    if (matchRatio < requiredMatchRatio) {
      return false;
    }

    if (lineBucket !== 'short' && !tailCoverage) {
      return false;
    }

    if (transcriptWasFinal) {
      return true;
    }

    const minimumWords =
      lineBucket === 'long' ? 7 : lineBucket === 'medium' ? 5 : 2;
    return this.countWords(accumulatedTranscript) >= minimumWords;
  }

  private shouldScheduleStaleMatch(
    lineBucket: LineBucket,
    matchRatio: number,
    tailCoverage: boolean,
  ): boolean {
    if (!tailCoverage) {
      return false;
    }

    // Long lines require a stricter ratio than medium/short. Previously
    // disabled entirely on long lines, which left the silence timer (up to
    // 15s) as the only escape hatch when an actor finished a monologue
    // imperfectly. The 0.6 floor is high enough that genuinely-stalled
    // partials don't trip it, and tailCoverage already proves the actor
    // reached the end of the line.
    const minimumRatio =
      lineBucket === 'short'
        ? Math.max(this.staleMatchMinRatio, 0.85)
        : lineBucket === 'medium'
          ? Math.max(this.staleMatchMinRatio, 0.75)
          : Math.max(this.staleMatchMinRatio, 0.6);

    return matchRatio >= minimumRatio;
  }

  private countWords(text: string): number {
    const normalized = text.trim();
    if (!normalized) return 0;
    return normalized.split(/\s+/).length;
  }
}
