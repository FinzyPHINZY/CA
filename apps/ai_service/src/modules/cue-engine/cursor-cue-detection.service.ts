// sliding window cursor cue detection engine.
//
// replaces the Jaccard bag-of-words approach with a forward-only cursor that
// tracks the actor's word-by-word position within the scene's content words.
//
// key properties:
//   - cursor only moves forward (no false backward jumps)
//   - stop words are invisible to the cursor (single "I" cannot advance)
//   - lookahead window tolerates skipped/missed words
//   - short lines have stricter thresholds to prevent premature advance
//   - lines with only stop words fall back to full-text substring matching
//   - fuzzy matching (Levenshtein + stemming) tolerates transcription errors
//   - sliding window on transcript tail ignores early stumbles/noise

import { Injectable, Logger } from '@nestjs/common';
import { CursorStateService } from './cursor-state.service';
import { isWordMatch } from './fuzzy-match.util';
import type { CursorCueDecision, CursorState } from './types/cue-engine.types';

// Lookahead window bounds. Forward search distance is scaled per-turn by
// `computeLookaheadSize` so short lines stay tight (false-positive control)
// while long lines get enough headroom to tolerate skipped/stumbled words.
const LOOKAHEAD_MIN = 3;
const LOOKAHEAD_MAX = 8;
const LOOKAHEAD_RATIO = 0.4;

// Backward tolerance window. When a transcript word matches a scene word
// 1–2 positions BEHIND the cursor, we credit the match (the actor clearly
// said it) without moving the cursor — preserving the forward-only commit
// invariant. This is what lets a long-line re-read count after a stumble.
const BACKWARD_TOLERANCE = 2;

// advance thresholds based on turn content word count.
// Long/medium: lowered from 0.85/0.75 after W2 introduced per-turn Deepgram
// keyword boosting — with the upcoming line's vocabulary biased on the
// recognizer, false-positive matches stay low.
// Short bucket is split by exact content word count:
//   - 1–2 content words require a full 1.0 match (false-positive risk is
//     high on tiny lines where a single stray word can clear a low ratio).
//   - 3 content words allow one miss (2/3 ≈ 0.66). At 0.85 the bucket
//     effectively required an all-or-nothing match and stranded the session
//     on any transcription error — the fuzzy match cannot repair a 3-edit
//     substitution like "about" → "able".
const ADVANCE_THRESHOLD_LONG = 0.7;
const ADVANCE_THRESHOLD_MEDIUM = 0.65;
const ADVANCE_THRESHOLD_SHORT_TINY = 1.0; // 1–2 content words
const ADVANCE_THRESHOLD_SHORT_THREE = 0.66; // 3 content words
const PARTIAL_THRESHOLD = 0.25;

// Drift detection: a committed transcript far longer than the expected
// line with very little match signal means the matcher is stranded.
// Surfaces a recoverable reset signal to the gateway + frontend.
const DRIFT_TRANSCRIPT_MULTIPLIER = 2.0;
const DRIFT_MAX_RATIO = 0.4;

// minimum number of transcript content words before evaluating
const MIN_CONTENT_WORDS_FOR_EVAL = 1;

// sliding window multiplier: only look at the last N content words of transcript,
// where N = expectedContentWords * WINDOW_MULTIPLIER. This ignores noise/stumbles
// at the start of the actor's speech.
const WINDOW_MULTIPLIER = 2.0;

@Injectable()
export class CursorCueDetectionService {
  private readonly logger = new Logger(CursorCueDetectionService.name);

  constructor(private readonly cursorState: CursorStateService) {}

  /**
   * Evaluate a transcript against the cursor's current position.
   *
   * @param rehearsalId   - Session identifier
   * @param transcript    - Accumulated transcript text from Deepgram
   * @param turnIndex     - Current turn index in the sequence
   * @param expectedLine  - The full expected line text (for stop-word-only fallback)
   * @param isInterim     - True for interim results, false for final
   * @param confidence    - Deepgram confidence score (0-1)
   */
  async evaluate(
    rehearsalId: string,
    transcript: string,
    turnIndex: number,
    expectedLine: string,
    isInterim: boolean,
    confidence: number = 1,
  ): Promise<CursorCueDecision> {
    const state = await this.cursorState.getCursorState(rehearsalId);
    if (!state) {
      return {
        matchRatio: 0,
        cursorPosition: 0,
        decision: 'none',
        tailCoverage: false,
        lineBucket: 'short',
        totalContentWords: 0,
      };
    }

    const range = state.turnWordRanges[turnIndex];

    // if this turn has no content words (stop-word-only line like "I do."),
    // fall back to full-text substring matching
    if (!range || range.totalContentWords === 0) {
      return this.evaluateStopWordOnlyLine(transcript, expectedLine, state);
    }

    // sync turn index if changed (defensive — gateway should call
    // resetForNewTurn before evaluate(), but if it doesn't, mirror the same
    // behavior here). Do NOT set pendingRewindBaseline on a forward sync —
    // explicit rewinds go through resetCursorForTurn which already sets it.
    if (state.currentTurnIndex !== turnIndex) {
      state.currentTurnIndex = turnIndex;
      state.currentTurnMatchedCount = 0;
      state.committedContentWords = [];
      state.lastProcessedContentWords = [];
    }

    // extract content words from the transcript (with stemming)
    const allTranscriptContentWords =
      CursorStateService.extractContentWords(transcript);

    if (allTranscriptContentWords.length < MIN_CONTENT_WORDS_FOR_EVAL) {
      this.cursorState.updateInMemory(rehearsalId, state);
      return {
        matchRatio: 0,
        cursorPosition: state.cursorPosition,
        decision: 'none',
        tailCoverage: false,
        lineBucket: range.lineBucket,
        totalContentWords: range.totalContentWords,
      };
    }

    // post-rewind baseline: after a cue.back / retry / new turn, Deepgram's
    // socket may still be streaming an interim transcript that contains words
    // spoken BEFORE the rewind. If we treat those as "new", they walk the
    // cursor forward through stale matches and poison every subsequent event.
    // Swallow exactly one event as the baseline so only words spoken AFTER the
    // rewind are considered new.
    if (state.pendingRewindBaseline) {
      state.lastProcessedContentWords = allTranscriptContentWords;
      state.committedContentWords = allTranscriptContentWords;
      state.pendingRewindBaseline = false;
      this.cursorState.updateInMemory(rehearsalId, state);
      if (!isInterim) {
        await this.cursorState.syncToRedis(rehearsalId);
      }
      return {
        matchRatio: 0,
        cursorPosition: state.cursorPosition,
        decision: 'none',
        tailCoverage: false,
        lineBucket: range.lineBucket,
        totalContentWords: range.totalContentWords,
      };
    }

    // sliding window: only use the tail of the transcript to avoid noise
    // from early stumbles ("uh one two three, hey what's cookin")
    const windowSize = Math.max(
      Math.ceil(range.totalContentWords * WINDOW_MULTIPLIER),
      MIN_CONTENT_WORDS_FOR_EVAL,
    );
    const transcriptContentWords =
      allTranscriptContentWords.length > windowSize
        ? allTranscriptContentWords.slice(-windowSize)
        : allTranscriptContentWords;

    // compute new words (dedup against previously processed)
    const newWords = this.computeNewWords(
      transcriptContentWords,
      state,
      isInterim,
    );

    // advance cursor for each new word found in the lookahead window.
    // Each match contributes a flat 1.0 to the matched count. Confidence is
    // NOT applied here — we previously multiplied the numerator by confidence
    // while leaving the denominator (totalContentWords) raw, which collapsed
    // the match ratio on accented reads where Deepgram returns modest
    // confidences (~0.7-0.85). A perfect read at confidence 0.7 capped at
    // matchRatio 0.7, barely clearing the long-line threshold; a 3/4 read at
    // the same confidence produced 0.525 and got stuck. Confidence is still
    // used as a gate in decide() for interim advance/partial decisions, so
    // low-quality signal is still rejected — just not by deflating the ratio.
    //
    // Lookahead is scaled per-turn: tight on short lines (false-positive
    // control), wider on long lines (tolerance for stumbled/skipped words).
    const lookaheadSize = this.computeLookaheadSize(range.totalContentWords);

    for (const word of newWords) {
      const matchOffset = this.findInWindow(
        word,
        state.sceneContentWords,
        state.cursorPosition,
        lookaheadSize,
      );

      if (matchOffset >= 0) {
        const newPosition = state.cursorPosition + matchOffset + 1;

        // count how many matched positions fall within the current turn's range
        for (
          let pos = state.cursorPosition + matchOffset;
          pos < newPosition;
          pos++
        ) {
          if (pos >= range.start && pos < range.end) {
            state.currentTurnMatchedCount += 1;
          }
        }

        state.cursorPosition = newPosition;
        continue;
      }

      // Forward search missed — try the backward tolerance window.
      // A match 1–2 positions behind the cursor means the actor re-read
      // a word they already passed (common after a stumble). Credit the
      // match toward the matchRatio but do NOT move the cursor backward
      // — forward-only commit is preserved.
      //
      // Gate the credit on the skip-gap: forward advance credits only the
      // positions the cursor LANDS on, so a forward skip leaves uncredited
      // positions behind the cursor. Only those uncredited positions are
      // valid backward-credit targets — otherwise an interim that already
      // advanced cleanly would double-count its own words when the matching
      // final transcript arrives.
      const turnEndForGap = Math.min(state.cursorPosition, range.end);
      const cursorDistanceInTurn = turnEndForGap - range.start;
      if (state.currentTurnMatchedCount >= cursorDistanceInTurn) {
        continue;
      }

      if (
        this.findBehindCursor(
          word,
          state.sceneContentWords,
          state.cursorPosition,
          BACKWARD_TOLERANCE,
          range.start,
          range.end,
        )
      ) {
        // cap the credit at totalContentWords so the ratio can't exceed 1.0
        if (state.currentTurnMatchedCount < range.totalContentWords) {
          state.currentTurnMatchedCount += 1;
        }
      }
    }

    // update dedup tracking
    if (isInterim) {
      state.lastProcessedContentWords = transcriptContentWords;
    } else {
      state.committedContentWords = transcriptContentWords;
      state.lastProcessedContentWords = transcriptContentWords;
    }

    // compute match ratio
    const matchRatio =
      range.totalContentWords > 0
        ? Math.min(state.currentTurnMatchedCount / range.totalContentWords, 1.0)
        : 0;

    // also check if cursor has passed beyond this turn's range entirely
    const cursorPastTurn = state.cursorPosition >= range.end;
    const tailCoverage =
      range.totalContentWords > 0 && state.cursorPosition > range.tailStart;

    // persist state
    this.cursorState.updateInMemory(rehearsalId, state);
    if (!isInterim) {
      await this.cursorState.syncToRedis(rehearsalId);
    }

    // Drift detection: a committed transcript that has grown well beyond
    // the line length while matching very little is a sign the cursor is
    // stranded somewhere it can't recover from (e.g., Deepgram mis-
    // transcribed the first half, the actor restarted, and the cumulative
    // text no longer aligns to the script). Signal the gateway to clear
    // the buffer, rewind the cursor, and finalize the Deepgram socket.
    //
    // Only evaluated on final transcripts — interim streams can balloon
    // mid-utterance and resolve cleanly once Deepgram emits the final.
    if (
      !isInterim &&
      range.totalContentWords > 0 &&
      allTranscriptContentWords.length >
        range.totalContentWords * DRIFT_TRANSCRIPT_MULTIPLIER &&
      matchRatio < DRIFT_MAX_RATIO
    ) {
      return {
        matchRatio,
        cursorPosition: state.cursorPosition,
        decision: 'drift_reset',
        tailCoverage: tailCoverage || cursorPastTurn,
        lineBucket: range.lineBucket,
        totalContentWords: range.totalContentWords,
      };
    }

    const decision = this.decide(
      matchRatio,
      tailCoverage || cursorPastTurn,
      range.lineBucket,
      range.totalContentWords,
      isInterim,
      confidence,
    );

    return {
      matchRatio,
      cursorPosition: state.cursorPosition,
      decision,
      tailCoverage: tailCoverage || cursorPastTurn,
      lineBucket: range.lineBucket,
      totalContentWords: range.totalContentWords,
    };
  }

  /**
   * Determine the decision based on match ratio, turn length, and confidence.
   */
  private decide(
    matchRatio: number,
    tailCoverage: boolean,
    lineBucket: CursorCueDecision['lineBucket'],
    totalContentWords: number,
    isInterim: boolean,
    confidence: number,
  ): CursorCueDecision['decision'] {
    const threshold = this.getAdvanceThreshold(lineBucket, totalContentWords);

    if (isInterim) {
      if (lineBucket === 'long') {
        if (matchRatio >= PARTIAL_THRESHOLD && confidence >= 0.7) {
          return 'partial';
        }
        return 'none';
      }

      if (tailCoverage && matchRatio >= threshold && confidence >= 0.9) {
        return 'advance';
      }
      if (matchRatio >= PARTIAL_THRESHOLD && confidence >= 0.7)
        return 'partial';
      return 'none';
    }

    if (lineBucket === 'short') {
      if (matchRatio >= threshold) return 'advance';
      if (matchRatio >= PARTIAL_THRESHOLD) return 'partial';
      return 'none';
    }

    if (tailCoverage && matchRatio >= threshold) return 'advance';
    if (matchRatio >= PARTIAL_THRESHOLD) return 'partial';
    return 'none';
  }

  /**
   * Get the advance threshold based on the number of content words in the turn.
   * Short bucket (≤3 content words) is split by exact count: 1–2 content words
   * require an exact match (1.0); 3 content words allow one miss (0.66).
   */
  private getAdvanceThreshold(
    lineBucket: CursorCueDecision['lineBucket'],
    totalContentWords: number,
  ): number {
    if (lineBucket === 'short') {
      return totalContentWords <= 2
        ? ADVANCE_THRESHOLD_SHORT_TINY
        : ADVANCE_THRESHOLD_SHORT_THREE;
    }
    if (lineBucket === 'medium') return ADVANCE_THRESHOLD_MEDIUM;
    return ADVANCE_THRESHOLD_LONG;
  }

  /**
   * Compute per-turn forward lookahead size. Clamped to [LOOKAHEAD_MIN,
   * LOOKAHEAD_MAX] around 40% of the turn's content-word count.
   */
  private computeLookaheadSize(totalContentWords: number): number {
    const scaled = Math.ceil(totalContentWords * LOOKAHEAD_RATIO);
    return Math.min(LOOKAHEAD_MAX, Math.max(LOOKAHEAD_MIN, scaled));
  }

  /**
   * Find a word in the lookahead window ahead of the cursor.
   * Uses fuzzy matching (Levenshtein + stem comparison) instead of exact equality.
   * Returns the offset from cursorPosition where the word was found, or -1.
   */
  private findInWindow(
    word: string,
    sceneWords: string[],
    cursorPosition: number,
    windowSize: number,
  ): number {
    const windowEnd = Math.min(cursorPosition + windowSize, sceneWords.length);

    for (let i = cursorPosition; i < windowEnd; i++) {
      if (isWordMatch(sceneWords[i], word)) {
        return i - cursorPosition;
      }
    }

    return -1;
  }

  /**
   * Search the small window immediately behind the cursor (within the
   * current turn's range) for a fuzzy match. Used to credit re-reads that
   * fall behind the forward cursor — without rewinding it.
   *
   * Returns true if a match was found AND the matched position lies within
   * the current turn's word range (so we don't credit re-reads of prior
   * turns toward the current turn's matchRatio).
   */
  private findBehindCursor(
    word: string,
    sceneWords: string[],
    cursorPosition: number,
    tolerance: number,
    turnRangeStart: number,
    turnRangeEnd: number,
  ): boolean {
    const start = Math.max(turnRangeStart, cursorPosition - tolerance);
    const end = Math.min(turnRangeEnd, cursorPosition);
    for (let i = start; i < end; i++) {
      if (isWordMatch(sceneWords[i], word)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Compute genuinely new content words from the transcript,
   * deduplicating against previously processed words.
   */
  private computeNewWords(
    currentWords: string[],
    state: CursorState,
    isInterim: boolean,
  ): string[] {
    const baseWords = isInterim
      ? state.lastProcessedContentWords
      : state.committedContentWords;

    if (baseWords.length === 0) return currentWords;

    // find words in current that extend beyond the base
    // handle the common case: current is base + new tail words
    if (
      currentWords.length > baseWords.length &&
      this.startsWithSequence(currentWords, baseWords)
    ) {
      return currentWords.slice(baseWords.length);
    }

    // fallback: find words in current not present in base (by position)
    // this handles Deepgram revising interim transcripts
    const seen = new Map<string, number>();

    for (const w of baseWords) {
      seen.set(w, (seen.get(w) || 0) + 1);
    }

    const newWords: string[] = [];
    for (const w of currentWords) {
      const baseCount = seen.get(w) || 0;
      if (baseCount > 0) {
        seen.set(w, baseCount - 1);
      } else {
        newWords.push(w);
      }
    }

    return newWords;
  }

  /**
   * Check if arr starts with the given prefix sequence.
   */
  private startsWithSequence(arr: string[], prefix: string[]): boolean {
    if (arr.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
      if (arr[i] !== prefix[i]) return false;
    }
    return true;
  }

  /**
   * Fallback for lines with zero content words after stop-word removal
   * (e.g., "I do.", "I am.", "Oh no.").
   * Uses full-text substring matching with fuzzy word comparison.
   */
  private evaluateStopWordOnlyLine(
    transcript: string,
    expectedLine: string,
    state: CursorState,
  ): CursorCueDecision {
    const normalizedTranscript = transcript
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim();
    const normalizedExpected = expectedLine
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim();

    if (!normalizedTranscript || !normalizedExpected) {
      return {
        matchRatio: 0,
        cursorPosition: state.cursorPosition,
        decision: 'none',
        tailCoverage: false,
        lineBucket: 'short',
        totalContentWords: 0,
      };
    }

    // check if the transcript contains the expected line
    const contains = normalizedTranscript.includes(normalizedExpected);

    // word-level overlap with fuzzy matching
    const tWords = normalizedTranscript.split(/\s+/);
    const eWords = normalizedExpected.split(/\s+/);
    const matchCount = eWords.filter((ew) =>
      tWords.some((tw) => isWordMatch(tw, ew)),
    ).length;
    const matchRatio = eWords.length > 0 ? matchCount / eWords.length : 0;

    if (contains || matchRatio >= 0.7) {
      return {
        matchRatio: 1.0,
        cursorPosition: state.cursorPosition,
        decision: 'advance',
        tailCoverage: true,
        lineBucket: 'short',
        totalContentWords: 0,
      };
    }

    if (matchRatio >= 0.4) {
      return {
        matchRatio,
        cursorPosition: state.cursorPosition,
        decision: 'partial',
        tailCoverage: false,
        lineBucket: 'short',
        totalContentWords: 0,
      };
    }

    return {
      matchRatio,
      cursorPosition: state.cursorPosition,
      decision: 'none',
      tailCoverage: false,
      lineBucket: 'short',
      totalContentWords: 0,
    };
  }
}
