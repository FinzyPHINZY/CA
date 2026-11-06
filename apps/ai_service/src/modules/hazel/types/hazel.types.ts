/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import type { SessionSettings } from '@app/common';

// shared types for the Hazel AI Orchestrator (Sub-Phase 4.1).

export type TurnType = 'actor' | 'hazel' | 'action' | 'parenthetical';

export type SessionStatus =
  | 'preparing'
  | 'ready'
  | 'active'
  | 'paused'
  | 'ended';

/** Single element in the turn sequence — the source of truth for session ordering. */
export interface Turn {
  index: number;
  type: TurnType;
  characterName?: string;
  characterId?: string;
  text: string;
  lines: string[];
  pauseMs?: number;
}

/** Session state persisted in Redis at `hazel:{rehearsalId}:state` with 4-hour TTL. */
export interface HazelSessionState {
  rehearsalId: string;
  userId: string;
  lockToken: string | null;
  sceneId: string;
  characterId: string;
  currentLineIndex: number;
  currentTurn: TurnType;
  status: SessionStatus;
  voiceMap: Record<string, string>;
  isHazelSpeaking: boolean;
  lastHazelLineIndex: number;
  totalLines: number;
  deepgramKeyId: string;
  startedAt: string;
  lastSocketDisconnectAt: string | null;
  pausedAt: string | null;
  totalPausedMs: number;
  recordingChannelName: string | null;
  agoraResourceId: string | null;
  agoraSid: string | null;
  previousHazelCharacterName: string | null;
  /**
   * Frozen session settings snapshot — pushed at session start.
   * Source of truth for cue/silence/turn behavior during the session.
   */
  settings: SessionSettings;
  /**
   * Loop iteration counter. Incremented on each scene-complete wraparound
   * when settings.loopMode === true. Capped by LOOP_MAX_ITERATIONS.
   */
  loopIteration: number;
  /** ISO timestamp set when the current actor turn was presented; used to
   *  compute the actor's response time at turn.end. Null outside actor turns. */
  actorTurnStartedAt: string | null;
}

/** Pre-generation progress — `hazel:{rehearsalId}:prep:progress`. */
export interface PrepProgress {
  total: number;
  completed: number;
  failed: number;
  status: 'running' | 'done' | 'failed';
}
