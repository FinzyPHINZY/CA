// Shared types for the teleprompter module. Engine-agnostic line-driven
// rehearsal — every dialogue element becomes a `kind: 'line'` turn,
// regardless of which character speaks it. Cue detection is speaker-agnostic.

export type TeleprompterTurnKind = 'line' | 'action' | 'parenthetical';

export type TeleprompterSessionStatus =
  | 'preparing'
  | 'ready'
  | 'active'
  | 'paused'
  | 'ended';

export type TeleprompterDetectionMode = 'AUTO' | 'MANUAL';

export type TeleprompterSilencePace = 'fast' | 'normal' | 'patient';

/** Single element in the teleprompter turn sequence. */
export interface TeleprompterTurn {
  index: number;
  kind: TeleprompterTurnKind;
  characterName?: string;
  characterId?: string;
  text: string;
  lines: string[];
  /** ms to display before auto-advancing. Set for action (2000) and parenthetical (800). */
  pauseMs?: number;
}

/** Frozen session settings — set on session.start, immutable for the session lifetime. */
export interface TeleprompterSettings {
  detectionMode: TeleprompterDetectionMode;
  silencePace: TeleprompterSilencePace;
  autoAdvanceOnSilence: boolean;
  /**
   * When true, scene action elements (e.g. "[she enters with a knife]") are
   * included in the turn sequence and emitted as `action.display` events
   * with a 2s auto-advance. When false (default), action elements are
   * stripped entirely at build time — sequence shorter, no dead-time pause,
   * FE renders only dialogue + parentheticals.
   */
  includeActions: boolean;
}

/**
 * Session state persisted in Redis at `tp:{rehearsalId}:state` with 4h TTL.
 * Slimmer than HazelSessionState — no voiceMap, no isHazelSpeaking, no
 * recording channel, no loop iteration, no character-specific tracking.
 */
export interface TeleprompterSessionState {
  userId: string;
  rehearsalId: string;
  sceneId: string;
  status: TeleprompterSessionStatus;
  currentLineIndex: number;
  currentTurn: TeleprompterTurnKind;
  totalLines: number;
  totalPausedMs: number;
  pausedAt: string | null;
  startedAt: string;
  /** Committed transcript baseline for the active line — only finals append here. Cleared on advance/reset. */
  committedTranscript: string;
  /** Live transcript = committedTranscript + current interim (or = committedTranscript when no interim). Cleared on advance/reset. */
  accumulatedTranscript: string;
  /** Latest single transcript fragment (interim or final). For logging. */
  fragmentTranscript: string;
  /** Number of failed final attempts on the current line. Capped at MAX_LINE_MISMATCH. */
  lineMismatchCount: number;
  settings: TeleprompterSettings;
  /** Last Deepgram keyword list emitted to FE — for jaccard reconnect suppression. */
  lastEmittedKeywords: string[] | null;
  /** Ephemeral Deepgram session key id for revocation on session.end. */
  deepgramKeyId: string | null;
  /** Recorded when socket disconnects — reaper uses this to detect stale sessions. */
  lastSocketDisconnectAt: string | null;
}
