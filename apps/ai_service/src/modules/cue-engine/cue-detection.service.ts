/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

// word-overlap cue matching engine. Normalized Jaccard similarity.
// thresholds: ≥0.75 → advance, 0.40–0.74 → partial, <0.40 → none.
// isHazelSpeaking gate (4.1.27): transcript evaluation is blocked when
// session.isHazelSpeaking is true. This check happens in the gateway
// before calling evaluate().

import { Injectable } from '@nestjs/common';
import type { CueDecision } from './types/cue-engine.types';

const ADVANCE_THRESHOLD = 0.75;
const PARTIAL_THRESHOLD = 0.4;
const HIGH_CONFIDENCE_INTERIM = 0.92;
const PARTIAL_HINT_CONFIDENCE = 0.85;

@Injectable()
export class CueDetectionService {
  // evaluate a transcript against the expected actor line.
  // @param transcript  - Text received from Deepgram
  // @param expectedLine - The actor's expected line text
  // @param isInterim   - True for interim results, false for final
  // @param confidence  - Deepgram confidence score (0–1)
  evaluate(
    transcript: string,
    expectedLine: string,
    isInterim: boolean,
    confidence: number = 1,
  ): CueDecision {
    const tWords = this.normalize(transcript);
    const eWords = this.normalize(expectedLine);

    if (tWords.size === 0 || eWords.size === 0) {
      return { matchRatio: 0, decision: 'none' };
    }

    const intersection = new Set([...tWords].filter((w) => eWords.has(w)));
    const union = new Set([...tWords, ...eWords]);
    const matchRatio = intersection.size / union.size;

    const decision = this.decide(matchRatio, isInterim, confidence);
    return { matchRatio, decision };
  }

  private decide(
    matchRatio: number,
    isInterim: boolean,
    confidence: number,
  ): CueDecision['decision'] {
    if (isInterim) {
      // on interim: only advance if confidence is very high
      if (
        matchRatio >= ADVANCE_THRESHOLD &&
        confidence >= HIGH_CONFIDENCE_INTERIM
      ) {
        return 'advance';
      }
      // rmit partial hint if confidence meets minimum
      if (
        matchRatio >= PARTIAL_THRESHOLD &&
        confidence >= PARTIAL_HINT_CONFIDENCE
      ) {
        return 'partial';
      }
      return 'none';
    }

    // final transcript
    if (matchRatio >= ADVANCE_THRESHOLD) return 'advance';
    if (matchRatio >= PARTIAL_THRESHOLD) return 'partial';
    return 'none';
  }

  private normalize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0),
    );
  }
}
