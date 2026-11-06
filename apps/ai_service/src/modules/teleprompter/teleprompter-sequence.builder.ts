// TeleprompterSequenceBuilder — converts scene dialogue elements into the
// teleprompter Turn[] sequence and persists it to Redis. Speaker-agnostic:
// every dialogue element becomes a `kind: 'line'` turn regardless of which
// character speaks it. No merging across characters (keeps line boundaries
// crisp for cursor matching).
//
// Redis key: tp:{rehearsalId}:sequence (TTL: 4h, matches session state)

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  SceneRepository,
  RehersalRepository,
  buildSequenceSnapshot,
  REHEARSAL_SEQUENCE_SNAPSHOT_KEY,
  REHEARSAL_SEQUENCE_SNAPSHOT_META_KEY,
} from '@app/common';
import { CursorStateService } from '../cue-engine/cursor-state.service';
import type { TeleprompterTurn } from './types/teleprompter.types';

const SEQUENCE_TTL_SECONDS = 4 * 60 * 60;
const TELEPROMPTER_SPEAKABLE_TYPE = 'line';

@Injectable()
export class TeleprompterSequenceBuilder {
  private readonly logger = new Logger(TeleprompterSequenceBuilder.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly sceneRepository: SceneRepository,
    private readonly cursorStateService: CursorStateService,
    private readonly rehersalRepository: RehersalRepository,
  ) {}

  private sequenceKey(rehearsalId: string) {
    return `tp:${rehearsalId}:sequence`;
  }

  /**
   * Build the turn sequence for a scene and persist to Redis. Also builds
   * the cursor word-index against `speakableType='line'` so the cursor
   * engine tracks teleprompter advances correctly.
   *
   * `includeActions` (default false) controls whether scene action elements
   * are kept in the sequence. When false, action elements are filtered at
   * build time — sequence shorter, no dead-time auto-advance pause, FE
   * renders only dialogue + parentheticals.
   */
  async buildForScene(
    rehearsalId: string,
    sceneId: string,
    includeActions: boolean = false,
  ): Promise<TeleprompterTurn[]> {
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene not found: ${sceneId}`);
    }

    const turns: TeleprompterTurn[] = [];
    for (const element of scene.dialogues ?? []) {
      const lines = element.lines ?? [];
      const text = lines.join(' ');
      const elementType = (element.type ?? 'dialogue') as
        | 'dialogue'
        | 'action'
        | 'parenthetical';

      if (elementType === 'action') {
        if (!includeActions) continue;
        turns.push({
          index: turns.length,
          kind: 'action',
          text,
          lines,
          pauseMs: 2000,
        });
        continue;
      }

      if (elementType === 'parenthetical') {
        turns.push({
          index: turns.length,
          kind: 'parenthetical',
          characterName: element.characterName ?? undefined,
          text,
          lines,
          pauseMs: 800,
        });
        continue;
      }

      // dialogue → speakable line, regardless of character
      turns.push({
        index: turns.length,
        kind: 'line',
        characterName: element.characterName ?? undefined,
        characterId: element.characterId ?? undefined,
        text,
        lines,
      });
    }

    await this.redis.set(
      this.sequenceKey(rehearsalId),
      JSON.stringify(turns),
      'EX',
      SEQUENCE_TTL_SECONDS,
    );

    this.logger.log(
      `Teleprompter sequence built for ${rehearsalId}: ${turns.length} turns ` +
        `(lines=${turns.filter((t) => t.kind === 'line').length}, ` +
        `actions=${turns.filter((t) => t.kind === 'action').length}, ` +
        `parens=${turns.filter((t) => t.kind === 'parenthetical').length}, ` +
        `includeActions=${includeActions})`,
    );

    // Build cursor index — pass speakableType='line' so the cursor only
    // tracks dialogue lines (matches our turn kind labels).
    await this.cursorStateService.buildSceneIndex(
      rehearsalId,
      turns.map((t) => ({
        index: t.index,
        type: t.kind,
        text: t.text,
        lines: t.lines,
        characterName: t.characterName,
        characterId: t.characterId,
        pauseMs: t.pauseMs,
      })),
      TELEPROMPTER_SPEAKABLE_TYPE,
    );

    await this.persistSnapshot(rehearsalId, turns, includeActions);

    return turns;
  }

  // Persist an immutable copy of the built sequence to the durable rehearsal
  // record (see RehearsalSequenceSnapshot). Best-effort: failure must not
  // break session start, so we log and continue. `includeActions` is captured
  // so the snapshot is fully self-describing.
  private async persistSnapshot(
    rehearsalId: string,
    turns: TeleprompterTurn[],
    includeActions: boolean,
  ): Promise<void> {
    try {
      const { entries, meta } = buildSequenceSnapshot(turns, 'teleprompter', {
        includeActions,
      });
      await this.rehersalRepository.mergeMetaData(rehearsalId, {
        [REHEARSAL_SEQUENCE_SNAPSHOT_KEY]: entries,
        [REHEARSAL_SEQUENCE_SNAPSHOT_META_KEY]: meta,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to persist sequence snapshot for ${rehearsalId}: ${(err as Error).message}`,
      );
    }
  }

  async getSequence(rehearsalId: string): Promise<TeleprompterTurn[]> {
    const raw = await this.redis.get(this.sequenceKey(rehearsalId));
    if (!raw) return [];
    return JSON.parse(raw) as TeleprompterTurn[];
  }

  async getTurn(
    rehearsalId: string,
    index: number,
  ): Promise<TeleprompterTurn | null> {
    const seq = await this.getSequence(rehearsalId);
    return seq[index] ?? null;
  }
}
