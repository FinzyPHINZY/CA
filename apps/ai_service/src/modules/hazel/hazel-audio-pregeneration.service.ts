/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
// pre-generates elevenlabs audio for all hazel turns at session prepare time.
// uses sha256-based global cache to deduplicate across sessions.
//
// redis keys:
//   hazel:audio:global:{hash}       → mp3 buffer (binary, ttl: 72h)
//   hazel:{rehearsalId}:audio:{idx} → hash string pointer (TTL: 4h)
//   hazel:{rehearsalId}:prep:progress → PrepProgress JSON

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import { ElevenLabsService } from './elevenlabs.service';
import { HazelSessionService } from './hazel-session.service';
import type { PrepProgress, Turn } from './types/hazel.types';

const GLOBAL_AUDIO_TTL = 72 * 60 * 60; // 72 hours
const SESSION_AUDIO_TTL = 4 * 60 * 60; // 4 hours
const PROGRESS_TTL = 4 * 60 * 60;

// simple inline concurrency limiter (p-limit equivalent).
function createLimit(concurrency: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        running++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            running--;
            if (queue.length > 0) queue.shift()!();
          });
      };
      if (running < concurrency) run();
      else queue.push(run);
    });
  };
}

@Injectable()
export class HazelAudioPreGenerationService {
  private readonly logger = new Logger(HazelAudioPreGenerationService.name);
  private readonly concurrency: number;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly elevenLabs: ElevenLabsService,
    private readonly configService: ConfigService,
    private readonly sessionService: HazelSessionService,
  ) {
    this.concurrency = this.configService.get<number>(
      'HAZEL_PREGEN_CONCURRENCY',
      5,
    );
  }

  // resolve voiceId for a hazel turn against the given voiceMap.
  // Returns null when the turn carries no characterId or the mapping is absent —
  // callers must treat this as "cannot generate" rather than falling back silently.
  private resolveVoiceId(
    turn: Turn,
    voiceMap: Record<string, string>,
  ): string | null {
    if (!turn.characterId) return null;
    return voiceMap[turn.characterId] ?? null;
  }

  private globalAudioKey(hash: string) {
    return `hazel:audio:global:${hash}`;
  }
  private sessionAudioKey(rehearsalId: string, idx: number) {
    return `hazel:${rehearsalId}:audio:${idx}`;
  }
  private progressKey(rehearsalId: string) {
    return `hazel:${rehearsalId}:prep:progress`;
  }

  private computeHash(voiceId: string, text: string): string {
    return createHash('sha256')
      .update(`${voiceId}|${text.trim().toLowerCase()}`)
      .digest('hex');
  }

  // pre-generate audio for all hazel-type turns.
  // voiceMap is a snapshot — callers resolve the live voiceMap from session state
  // and pass it in so pre-gen uses the same mapping that getAudioForLine will
  // use at playback time (identical hash → same cache slot).
  // returns when all lines have been attempted.
  async pregenerateSession(
    rehearsalId: string,
    turns: Turn[],
    voiceMap: Record<string, string>,
  ): Promise<void> {
    const hazelTurns = turns.filter((t) => t.type === 'hazel');
    const total = hazelTurns.length;

    if (total === 0) {
      await this.setProgress(rehearsalId, {
        total: 0,
        completed: 0,
        failed: 0,
        status: 'done',
      });
      return;
    }

    await this.setProgress(rehearsalId, {
      total,
      completed: 0,
      failed: 0,
      status: 'running',
    });

    const startedAt = Date.now();
    let failed = 0;

    const limit = createLimit(this.concurrency);

    await Promise.all(
      hazelTurns.map((turn) =>
        limit(async () => {
          const success = await this.generateLine(rehearsalId, turn, voiceMap);
          if (!success) {
            failed++;
            this.logger.error(
              `Pre-gen permanently failed for line ${turn.index} in ${rehearsalId}`,
            );
          }

          const progress = await this.getProgress(rehearsalId);
          await this.setProgress(rehearsalId, {
            ...progress,
            completed: (progress.completed ?? 0) + 1,
            failed,
          });
        }),
      ),
    );

    const wallMs = Date.now() - startedAt;
    const finalStatus = failed === total ? 'failed' : 'done';

    await this.setProgress(rehearsalId, {
      total,
      completed: total - failed,
      failed,
      status: finalStatus,
    });

    this.logger.log(
      `Pre-gen complete for ${rehearsalId}: total=${total}, failed=${failed}, wallMs=${wallMs}`,
    );
  }

  /**
   * Generate audio for a single hazel turn. Returns true on success (cached or
   * freshly generated), false if it could not be generated (no voice / TTS fail).
   */
  private async generateLine(
    rehearsalId: string,
    turn: Turn,
    voiceMap: Record<string, string>,
  ): Promise<boolean> {
    const voiceId = this.resolveVoiceId(turn, voiceMap);
    if (!voiceId) {
      this.logger.warn(
        `Skipping gen for line ${turn.index} — no voice for characterId "${turn.characterId ?? 'none'}"`,
      );
      return false;
    }
    const hash = this.computeHash(voiceId, turn.text);
    const globalKey = this.globalAudioKey(hash);
    const sessionKey = this.sessionAudioKey(rehearsalId, turn.index);

    if (await this.redis.exists(globalKey)) {
      await this.redis.set(sessionKey, hash, 'EX', SESSION_AUDIO_TTL);
      return true;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const audio = await this.elevenLabs.generateAudio(
          turn.text,
          voiceId,
          this.elevenLabs.defaultModelId,
        );
        await (this.redis as any).set(globalKey, audio, 'EX', GLOBAL_AUDIO_TTL);
        await this.redis.set(sessionKey, hash, 'EX', SESSION_AUDIO_TTL);
        return true;
      } catch (err: any) {
        this.logger.warn(
          `ElevenLabs attempt ${attempt} failed for line ${turn.index}: ${err.message}`,
        );
      }
    }
    return false;
  }

  /**
   * Generate ONLY the first hazel turn so the session can reach `ready` fast.
   * Returns the line index generated, or null if there is no hazel turn.
   */
  async pregenerateFirstHazelLine(
    rehearsalId: string,
    turns: Turn[],
    voiceMap: Record<string, string>,
  ): Promise<number | null> {
    const first = turns.find((t) => t.type === 'hazel');
    if (!first) return null;
    await this.generateLine(rehearsalId, first, voiceMap);
    return first.index;
  }

  // retrieve audio buffer for a specific session line.
  // Looks up the voiceId from the live session voiceMap so a mid-session
  // override is always honored — any stale session-audio pointer from a prior
  // voice is ignored because the global hash is recomputed from current state.
  async getAudioForLine(
    rehearsalId: string,
    lineIndex: number,
    turn?: Turn,
  ): Promise<Buffer> {
    const state = await this.sessionService.getSession(rehearsalId);
    const voiceMap = state?.voiceMap ?? {};

    if (turn) {
      const voiceId = this.resolveVoiceId(turn, voiceMap);
      if (voiceId) {
        const hash = this.computeHash(voiceId, turn.text);
        const globalKey = this.globalAudioKey(hash);
        const buf = (await (this.redis as any).getBuffer(
          globalKey,
        )) as Buffer | null;
        if (buf) return buf;

        this.logger.warn(
          `Cache miss for line ${lineIndex} in ${rehearsalId} — falling back to live TTS`,
        );
        return this.elevenLabs.generateAudio(
          turn.text,
          voiceId,
          this.elevenLabs.defaultModelId,
        );
      }
    }

    // no turn (or no resolvable voiceId): try the session-audio pointer as a last resort
    const sessionKey = this.sessionAudioKey(rehearsalId, lineIndex);
    const hash = await this.redis.get(sessionKey);
    if (hash) {
      const globalKey = this.globalAudioKey(hash);
      const buf = (await (this.redis as any).getBuffer(
        globalKey,
      )) as Buffer | null;
      if (buf) return buf;
    }

    if (!turn)
      throw new Error(`No turn data for fallback TTS at index ${lineIndex}`);

    throw new Error(
      `Cannot generate audio for line ${lineIndex} — no voice mapping for characterId "${turn.characterId ?? 'none'}" (character: ${turn.characterName ?? 'unknown'})`,
    );
  }

  /**
   * Streaming variant of `getAudioForLine` for the live playback path.
   *
   * Cache hit → yields the cached buffer in a single chunk (no observable
   * difference from buffered playback).
   *
   * Cache miss → streams from ElevenLabs' `/stream` endpoint so the actor
   * hears Hazel start within ~250ms instead of waiting ~1500ms for the
   * full buffer. While streaming out, chunks are accumulated and written
   * to Redis after the stream completes so subsequent hits for the same
   * line are cached.
   *
   * Errors thrown before the first chunk reach the caller synchronously;
   * mid-stream errors throw on iteration (caller decides recovery).
   */
  async *getAudioStreamForLine(
    rehearsalId: string,
    lineIndex: number,
    turn: Turn,
  ): AsyncIterable<Buffer> {
    const state = await this.sessionService.getSession(rehearsalId);
    const voiceMap = state?.voiceMap ?? {};
    const voiceId = this.resolveVoiceId(turn, voiceMap);

    if (!voiceId) {
      throw new Error(
        `Cannot generate audio for line ${lineIndex} — no voice mapping for characterId "${turn.characterId ?? 'none'}" (character: ${turn.characterName ?? 'unknown'})`,
      );
    }

    const hash = this.computeHash(voiceId, turn.text);
    const globalKey = this.globalAudioKey(hash);
    const cached = (await (this.redis as any).getBuffer(
      globalKey,
    )) as Buffer | null;

    if (cached) {
      yield cached;
      return;
    }

    this.logger.warn(
      `Cache miss for line ${lineIndex} in ${rehearsalId} — streaming live TTS`,
    );

    const chunks: Buffer[] = [];
    for await (const chunk of this.elevenLabs.generateAudioStream(
      turn.text,
      voiceId,
      this.elevenLabs.defaultModelId,
    )) {
      chunks.push(chunk);
      yield chunk;
    }

    // backfill the cache after streaming so subsequent requests for this
    // (voiceId, text) pair hit. Fire-and-forget — playback already completed.
    if (chunks.length > 0) {
      const full = Buffer.concat(chunks);
      const sessionKey = this.sessionAudioKey(rehearsalId, lineIndex);
      void (this.redis as any)
        .set(globalKey, full, 'EX', GLOBAL_AUDIO_TTL)
        .catch((err: any) =>
          this.logger.warn(
            `Cache backfill failed for line ${lineIndex}: ${err?.message ?? err}`,
          ),
        );
      void this.redis
        .set(sessionKey, hash, 'EX', SESSION_AUDIO_TTL)
        .catch((err: any) =>
          this.logger.warn(
            `Session pointer backfill failed for line ${lineIndex}: ${err?.message ?? err}`,
          ),
        );
    }
  }

  async getProgress(rehearsalId: string): Promise<PrepProgress> {
    const raw = await this.redis.get(this.progressKey(rehearsalId));
    if (!raw) return { total: 0, completed: 0, failed: 0, status: 'running' };
    return JSON.parse(raw) as PrepProgress;
  }

  private async setProgress(
    rehearsalId: string,
    progress: PrepProgress,
  ): Promise<void> {
    await this.redis.set(
      this.progressKey(rehearsalId),
      JSON.stringify(progress),
      'EX',
      PROGRESS_TTL,
    );
  }
}
