// Durable, rehearsal-scoped copy of the built turn sequence, persisted to
// `rehearsal.metaData.sequenceSnapshot` when a session's sequence is built.
//
// Why this exists: `lineIndex` on a RehearsalEvent is the position in the
// BUILT sequence (after Hazel's merge / Teleprompter's action filtering), NOT
// an index into the mutable `scene.dialogues` JSONB. The Redis sequence that
// produced it expires after 4h. So to resolve `lineIndex → text/character`
// durably and edit-proof, we snapshot the sequence at build time. Analytics
// resolves against this snapshot when an event itself didn't carry the data.

/** One turn of the built sequence, captured immutably for this rehearsal. */
export interface RehearsalSequenceSnapshotEntry {
  index: number;
  /** Turn type/kind: actor | hazel | line | action | parenthetical. */
  type: string;
  characterId: string | null;
  characterName: string | null;
  text: string | null;
}

export interface RehearsalSequenceSnapshotMeta {
  engine: 'hazel' | 'teleprompter';
  /** ISO timestamp the snapshot was written. */
  builtAt: string;
  turnCount: number;
  /** Teleprompter only — whether action elements were kept in the sequence. */
  includeActions?: boolean;
}

/** metaData JSONB keys (kept as constants so producer + consumer never drift). */
export const REHEARSAL_SEQUENCE_SNAPSHOT_KEY = 'sequenceSnapshot';
export const REHEARSAL_SEQUENCE_SNAPSHOT_META_KEY = 'sequenceSnapshotMeta';

/** Minimal turn shape both Hazel `Turn` and `TeleprompterTurn` satisfy. */
export interface SnapshotSourceTurn {
  index: number;
  type?: string;
  kind?: string;
  characterId?: string | null;
  characterName?: string | null;
  text?: string | null;
}

/**
 * Build the snapshot payload (entries + meta) from a freshly built turn
 * sequence. Pure — both engine builders share it, and it's unit-testable.
 * Text is trimmed; empty → null (never "").
 */
export function buildSequenceSnapshot(
  turns: SnapshotSourceTurn[],
  engine: 'hazel' | 'teleprompter',
  opts: { includeActions?: boolean } = {},
): {
  entries: RehearsalSequenceSnapshotEntry[];
  meta: RehearsalSequenceSnapshotMeta;
} {
  const entries: RehearsalSequenceSnapshotEntry[] = turns.map((t) => {
    const text =
      typeof t.text === 'string' && t.text.trim().length > 0
        ? t.text.trim()
        : null;
    return {
      index: t.index,
      type: t.type ?? t.kind ?? 'unknown',
      characterId: t.characterId ?? null,
      characterName: t.characterName ?? null,
      text,
    };
  });

  const meta: RehearsalSequenceSnapshotMeta = {
    engine,
    builtAt: new Date().toISOString(),
    turnCount: entries.length,
    ...(opts.includeActions !== undefined
      ? { includeActions: opts.includeActions }
      : {}),
  };

  return { entries, meta };
}
