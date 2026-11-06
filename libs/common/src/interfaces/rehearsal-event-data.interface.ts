// Shared contract for the `data` payload of a RehearsalEvent. This is the
// single source of truth for what producers (Hazel + Teleprompter session
// gateways/sequencers in ai_service) write and what the analytics projection
// (core RehearsalAnalyticsService) reads. Keeping both sides bound to this
// type is what prevents the producer/consumer drift that left `text` and
// `characterName` empty in difficult-lines.
//
// Invariant: `null` means "unknown". Never use "" as a stand-in for missing
// data — it defeats `?? fallback` guards and pollutes aggregates.

/** Max characters of line text persisted onto an event (avoids row bloat). */
export const MAX_EVENT_TEXT_LENGTH = 500;

/** Flexible event payload. Line-scoped events should carry the line-identity fields. */
export interface RehearsalEventData {
  lineIndex?: number;
  characterId?: string | null;
  characterName?: string | null;
  /** Human-readable script line text, normalized + truncated. null = unknown. */
  text?: string | null;
  mode?: string;
  transcript?: string;
  responseTimeMs?: number;
  matchRatio?: number;
  triggerType?: string;
  // Producers attach additional diagnostic fields (confidence, durationMs,
  // mismatchCount, …). They are preserved but not part of the strict contract.
  [key: string]: unknown;
}

/**
 * Minimal shape the event layer needs from a turn. Both the Hazel `Turn` and
 * the `TeleprompterTurn` structurally satisfy this, so the helper works for
 * either engine without importing engine-specific types into the shared lib.
 */
export interface TurnLike {
  index: number;
  characterId?: string | null;
  characterName?: string | null;
  text?: string | null;
}

/** Trim + NFC-normalize + truncate line text. Empty/whitespace/non-string → null. */
export function normalizeEventText(
  text: string | null | undefined,
): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.normalize('NFC').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_EVENT_TEXT_LENGTH
    ? trimmed.slice(0, MAX_EVENT_TEXT_LENGTH)
    : trimmed;
}

/**
 * Build a self-contained event-data payload for a line-scoped event.
 * Denormalizes the line text + character identity from the turn onto the
 * event so the analytics projection never has to resolve them from volatile
 * external state (Redis sequence / mutable scene JSONB).
 *
 * Turn-derived identity wins over `extra`; falls back to `extra` then `null`.
 * `extra` carries event-specific diagnostics (transcript, matchRatio, …).
 */
export function buildTurnEventData(
  turn: TurnLike | null | undefined,
  extra: RehearsalEventData = {},
): RehearsalEventData {
  return {
    ...extra,
    lineIndex: turn?.index ?? extra.lineIndex,
    characterId: turn?.characterId ?? extra.characterId ?? null,
    characterName: turn?.characterName ?? extra.characterName ?? null,
    text: normalizeEventText(
      turn?.text ?? (extra.text as string | null | undefined),
    ),
  };
}
