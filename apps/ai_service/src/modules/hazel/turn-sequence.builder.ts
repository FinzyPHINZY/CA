// turn sequence builder.
// maps scene dialogue elements to a typed Turn[] array.
// stores the sequence in Redis at hazel:{rehearsalId}:sequence (TTL: 4h).
//
// Turns carry characterId only — voiceId is resolved from session.voiceMap
// at TTS lookup time so voice overrides never require sequence rewrites.
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import {
  RehersalRepository,
  buildSequenceSnapshot,
  REHEARSAL_SEQUENCE_SNAPSHOT_KEY,
  REHEARSAL_SEQUENCE_SNAPSHOT_META_KEY,
} from '@app/common';
import type { Turn } from './types/hazel.types';
import type { SceneDialogueElement } from './hazel-scene-loader.service';
import { CursorStateService } from '../cue-engine/cursor-state.service';

const SEQUENCE_TTL_SECONDS = 4 * 60 * 60;

@Injectable()
export class TurnSequenceBuilder {
  private readonly logger = new Logger(TurnSequenceBuilder.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly cursorStateService: CursorStateService,
    private readonly rehersalRepository: RehersalRepository,
  ) {}

  private sequenceKey(rehearsalId: string) {
    return `hazel:${rehearsalId}:sequence`;
  }

  // build the Turn[] from scene elements and persist to Redis.
  // returns the built sequence.
  async build(
    rehearsalId: string,
    elements: SceneDialogueElement[],
    actorCharacterId: string,
  ): Promise<Turn[]> {
    const raw: Turn[] = [];

    for (const element of elements) {
      const type = element.type ?? 'dialogue';

      if (type === 'action') {
        raw.push({
          index: raw.length,
          type: 'action',
          text: element.lines.join(' '),
          lines: element.lines,
          pauseMs: 2000,
        });
        continue;
      }

      if (type === 'parenthetical') {
        raw.push({
          index: raw.length,
          type: 'parenthetical',
          characterName: element.characterName ?? undefined,
          text: element.lines.join(' '),
          lines: element.lines,
          pauseMs: 800,
        });
        continue;
      }

      // dialogue — determine actor vs hazel
      const isActor = element.characterId === actorCharacterId;

      raw.push({
        index: raw.length,
        type: isActor ? 'actor' : 'hazel',
        characterName: element.characterName ?? undefined,
        characterId: element.characterId ?? undefined,
        text: element.lines.join(' '),
        lines: element.lines,
      });
    }

    // merge consecutive dialogue turns from the same character
    const turns = this.mergeConsecutiveTurns(raw);

    await this.redis.set(
      this.sequenceKey(rehearsalId),
      JSON.stringify(turns),
      'EX',
      SEQUENCE_TTL_SECONDS,
    );

    this.logger.log(
      `Turn sequence built for ${rehearsalId}: ${turns.length} turns (` +
        `actor=${turns.filter((t) => t.type === 'actor').length}, ` +
        `hazel=${turns.filter((t) => t.type === 'hazel').length}, ` +
        `merged ${raw.length - turns.length} consecutive lines)`,
    );

    // build cursor index for the sliding window cue detection engine
    await this.cursorStateService.buildSceneIndex(rehearsalId, turns);

    await this.persistSnapshot(rehearsalId, turns);

    return turns;
  }

  // Persist an immutable copy of the built sequence to the durable rehearsal
  // record so analytics can resolve lineIndex → text/character forever (Redis
  // expires after 4h; scene.dialogues can be edited). Best-effort: a failure
  // here must not break session prep — event-level enrichment still covers
  // display text — so we log and continue.
  private async persistSnapshot(
    rehearsalId: string,
    turns: Turn[],
  ): Promise<void> {
    try {
      const { entries, meta } = buildSequenceSnapshot(turns, 'hazel');
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

  // merge consecutive dialogue/actor/hazel turns from the same character into one turn
  private mergeConsecutiveTurns(turns: Turn[]): Turn[] {
    if (turns.length === 0) return [];

    const merged: Turn[] = [turns[0]];

    for (let i = 1; i < turns.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = turns[i];

      const isMergeable =
        (curr.type === 'actor' || curr.type === 'hazel') &&
        curr.type === prev.type &&
        curr.characterName === prev.characterName;

      if (isMergeable) {
        prev.text = prev.text + ' ' + curr.text;
        prev.lines = [...prev.lines, ...curr.lines];
      } else {
        merged.push(curr);
      }
    }

    // re-index after merge
    for (let i = 0; i < merged.length; i++) {
      merged[i].index = i;
    }

    return merged;
  }

  async storeSequence(rehearsalId: string, turns: Turn[]): Promise<void> {
    await this.redis.set(
      this.sequenceKey(rehearsalId),
      JSON.stringify(turns),
      'EX',
      SEQUENCE_TTL_SECONDS,
    );
  }

  async getSequence(rehearsalId: string): Promise<Turn[]> {
    const raw = await this.redis.get(this.sequenceKey(rehearsalId));
    if (!raw) return [];
    return JSON.parse(raw) as Turn[];
  }

  async getTurn(rehearsalId: string, index: number): Promise<Turn | null> {
    const seq = await this.getSequence(rehearsalId);
    return seq[index] ?? null;
  }
}
