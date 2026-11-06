// Shared types for the cue-engine sub-module. Consumed by Hazel and the
// teleprompter module. Engine-specific types (e.g. Hazel's Turn union with
// `actor | hazel | action | parenthetical`, or HazelSessionState) live in
// the consuming module's own types file.

export type LineBucket = 'short' | 'medium' | 'long';

/**
 * Structural minimum required by the cue engine + Deepgram keyword window
 * builder. Consuming modules' richer turn types (e.g. Hazel's `Turn`) are
 * assignable to this via TypeScript structural typing. The `type` field is
 * left as a free `string` so each consumer can use its own narrower union.
 */
export interface CueTurn {
  index: number;
  type: string;
  text: string;
  lines: string[];
  characterName?: string;
  characterId?: string;
  pauseMs?: number;
}

/** Result of the cue detection engine. */
export interface CueDecision {
  matchRatio: number;
  decision: 'advance' | 'partial' | 'none';
}

/** Result of the cursor-based cue detection engine. */
export interface CursorCueDecision {
  matchRatio: number;
  cursorPosition: number;
  /**
   * - `advance`   — cue triggered, sequencer should advance to next turn.
   * - `partial`   — actor is mid-attempt, not yet ready to advance.
   * - `none`      — no meaningful signal.
   * - `drift_reset` — accumulated transcript has grown well past the
   *   expected length with a very low matchRatio. The matcher is confused;
   *   the gateway should clear the buffer, rewind the cursor, and notify
   *   the frontend to flush the Deepgram socket.
   */
  decision: 'advance' | 'partial' | 'none' | 'drift_reset';
  tailCoverage: boolean;
  lineBucket: LineBucket;
  totalContentWords: number;
}

/** Range of content-word indices belonging to a single turn. */
export interface TurnWordRange {
  start: number;
  end: number; // exclusive
  totalContentWords: number;
  tailStart: number;
  tailEnd: number; // exclusive
  lineBucket: LineBucket;
}

/** Cursor state persisted in Redis with a 4-hour TTL. */
export interface CursorState {
  /** Position of the cursor in the scene's content word array. */
  cursorPosition: number;
  /** The full scene's content words (stop words removed). */
  sceneContentWords: string[];
  /** Map from turn index to the range of content-word indices belonging to that turn. */
  turnWordRanges: Record<number, TurnWordRange>;
  /** Number of content words matched in the current turn so far. */
  currentTurnMatchedCount: number;
  /** Index of the current turn being tracked. */
  currentTurnIndex: number;
  /** Content words from committed (final) transcripts for dedup. */
  committedContentWords: string[];
  /** Content words from last processed transcript (interim or final) for dedup. */
  lastProcessedContentWords: string[];
  /**
   * Set true after a rewind/reset. The next transcript event is treated as a
   * baseline (its words are absorbed into the dedup state without advancing the
   * cursor) so stale words still buffered on Deepgram's side can't poison the
   * cursor on retry. Cleared after consuming exactly one event.
   */
  pendingRewindBaseline?: boolean;
}

/** Per-session state maintained in SilenceDetectionService. */
export interface SilenceState {
  lastTranscriptAt: number;
  lastMatchRatio: number;
  actorStarted: boolean;
  actorTurnStartedAt: number;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Fires when matchRatio stalls — prevents "stuck" feeling on partial matches. */
  staleMatchTimer: ReturnType<typeof setTimeout> | null;
  lastAccumulatedTranscript: string;
  lastTranscriptWasFinal: boolean;
  /** Highest matchRatio seen during this actor turn. */
  highWaterMatchRatio: number;
  /** Timestamp when highWaterMatchRatio was last updated. */
  highWaterMatchAt: number;
  /** Dynamic silence threshold for this turn, scaled by line word count. */
  dynamicSilenceMs: number;
  /** Dynamic stale-match threshold for this turn, scaled by line word count. */
  dynamicStaleMs: number;
  /** Size bucket for the current actor line. */
  lineBucket: LineBucket;
  /** Number of content words in the current actor line. */
  totalContentWords: number;
  /** Whether the actor has reached the tail portion of the line. */
  tailCoverage: boolean;
}
