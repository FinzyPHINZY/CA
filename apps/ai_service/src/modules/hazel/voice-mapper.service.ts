// assigns ElevenLabs voice IDs to non-actor characters using the account's
// actual available voices (fetched from Redis cache or ElevenLabs API).
// voices are selected by gender/age labels and spread across characters
// so different characters get different voices when possible.

import type { Character, VoiceMetadata } from '@app/common';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { ElevenLabsService } from './elevenlabs.service';

const VOICES_CACHE_KEY = 'hazel:voices:cache';

type VoiceCategory =
  | 'female_young'
  | 'female_middle'
  | 'female_old'
  | 'male_young'
  | 'male_middle'
  | 'male_old'
  | 'neutral';

const FEMALE_KEYWORDS = ['woman', 'female', 'girl', 'lady', 'she', 'her'];
const MALE_KEYWORDS = ['man', 'male', 'boy', 'gentleman', 'he', 'his', 'guy'];
const OLD_KEYWORDS = ['old', 'elderly', 'aged', 'senior', 'ancient'];
const YOUNG_KEYWORDS = ['young', 'teen', 'teenager', 'youth', 'kid', 'child'];

@Injectable()
export class VoiceMapperService implements OnModuleInit {
  private readonly logger = new Logger(VoiceMapperService.name);

  // categorised pools of available voice IDs
  private voicePools: Record<VoiceCategory, string[]> = {
    female_young: [],
    female_middle: [],
    female_old: [],
    male_young: [],
    male_middle: [],
    male_old: [],
    neutral: [],
  };

  // flat list of all available voice IDs (ultimate fallback)
  private allVoiceIds: string[] = [];
  private loaded = false;
  // dedupes a concurrent first-load so two builds racing before onModuleInit
  // completes don't both hit the ElevenLabs API / re-categorise.
  private loadingPromise: Promise<void> | null = null;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly elevenLabs: ElevenLabsService,
  ) {}

  async onModuleInit() {
    await this.loadVoices();
  }

  private async loadVoices(): Promise<void> {
    let voices: VoiceMetadata[] = [];

    // try Redis cache first (same key the controller uses)
    const cached = await this.redis.get(VOICES_CACHE_KEY);
    if (cached) {
      try {
        voices = JSON.parse(cached);
      } catch {
        this.logger.warn('Failed to parse cached voices, fetching fresh');
      }
    }

    // fallback to live API call
    if (voices.length === 0) {
      try {
        voices = await this.elevenLabs.listVoices();
      } catch (err: any) {
        this.logger.error(`Failed to fetch ElevenLabs voices: ${err.message}`);
        return;
      }
    }

    this.categoriseVoices(voices);
    this.loaded = true;
    this.logger.log(
      `Loaded ${voices.length} voices — ` +
        `female_young: ${this.voicePools.female_young.length}, ` +
        `female_middle: ${this.voicePools.female_middle.length}, ` +
        `female_old: ${this.voicePools.female_old.length}, ` +
        `male_young: ${this.voicePools.male_young.length}, ` +
        `male_middle: ${this.voicePools.male_middle.length}, ` +
        `male_old: ${this.voicePools.male_old.length}, ` +
        `neutral: ${this.voicePools.neutral.length}`,
    );
  }

  private categoriseVoices(voices: VoiceMetadata[]): void {
    // reset pools
    for (const key of Object.keys(this.voicePools) as VoiceCategory[]) {
      this.voicePools[key] = [];
    }
    this.allVoiceIds = voices.map((v) => v.voiceId);

    for (const voice of voices) {
      const gender = voice.labels?.gender?.toLowerCase() ?? '';
      const age = voice.labels?.age?.toLowerCase() ?? '';

      if (gender === 'neutral' || (!gender && !age)) {
        this.voicePools.neutral.push(voice.voiceId);
        continue;
      }

      const isFemale = gender === 'female';
      const isMale = gender === 'male';
      const isOld = age === 'old' || age === 'senior' || age === 'elderly';
      const isYoung = age === 'young' || age === 'teen' || age === 'child';

      if (isFemale && isOld) this.voicePools.female_old.push(voice.voiceId);
      else if (isFemale && isYoung)
        this.voicePools.female_young.push(voice.voiceId);
      else if (isFemale) this.voicePools.female_middle.push(voice.voiceId);
      else if (isMale && isOld) this.voicePools.male_old.push(voice.voiceId);
      else if (isMale && isYoung)
        this.voicePools.male_young.push(voice.voiceId);
      else if (isMale) this.voicePools.male_middle.push(voice.voiceId);
      else this.voicePools.neutral.push(voice.voiceId);
    }

    // sort every pool deterministically so assignment is stable across process
    // restarts and any reordering of the ElevenLabs /voices response.
    for (const key of Object.keys(this.voicePools) as VoiceCategory[]) {
      this.voicePools[key].sort();
    }
    this.allVoiceIds.sort();
  }

  // build a default voice map for all non-actor characters. returns { [characterId]: voiceId }
  async buildDefaultVoiceMap(
    characters: Character[],
    actorCharacterId: string,
  ): Promise<Record<string, string>> {
    // ensure voices are loaded (handles race if onModuleInit hasn't completed).
    // Memoize the in-flight load so concurrent builds share one fetch; clear it
    // after so a failed load (loaded still false) can be retried next call.
    if (!this.loaded) {
      this.loadingPromise ??= this.loadVoices().finally(() => {
        this.loadingPromise = null;
      });
      await this.loadingPromise;
    }

    // Per-build state only — never instance fields — so concurrent builds cannot
    // corrupt each other's assignment. `counters` give each category a stable
    // round-robin offset; `usedVoiceIds` enforces distinct voices across the map.
    const counters: Record<VoiceCategory, number> = {
      female_young: 0,
      female_middle: 0,
      female_old: 0,
      male_young: 0,
      male_middle: 0,
      male_old: 0,
      neutral: 0,
    };
    const usedVoiceIds = new Set<string>();

    const voiceMap: Record<string, string> = {};

    // Deterministic processing order, independent of caller ordering and of
    // character renames (sorted by immutable id).
    const orderedCharacters = [...characters]
      .filter((c) => c.id !== actorCharacterId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const character of orderedCharacters) {
      const voiceId = this.selectVoice(character, counters, usedVoiceIds);
      if (voiceId) {
        voiceMap[character.id] = voiceId;
        usedVoiceIds.add(voiceId);
        this.logger.debug(
          `Voice mapped: ${character.name} (${character.id}) → ${voiceId}`,
        );
      } else {
        this.logger.warn(`No voice available for character: ${character.name}`);
      }
    }

    return voiceMap;
  }

  // Pure with respect to instance state: reads the (immutable-after-load) pools
  // but mutates only the caller-owned `counters`/`usedVoiceIds`. Same inputs →
  // same output, and safe under concurrent buildDefaultVoiceMap calls.
  private selectVoice(
    character: Character,
    counters: Record<VoiceCategory, number>,
    usedVoiceIds: Set<string>,
  ): string | null {
    const candidateCategories: VoiceCategory[] = [];

    if (character.voiceProfile) {
      const g = character.voiceProfile.gender ?? 'neutral';
      const a = character.voiceProfile.ageCategory ?? 'middle';

      if (g === 'female') {
        if (a === 'old')
          candidateCategories.push('female_old', 'female_middle');
        else if (a === 'young')
          candidateCategories.push('female_young', 'female_middle');
        else
          candidateCategories.push(
            'female_middle',
            'female_young',
            'female_old',
          );
      } else if (g === 'male') {
        if (a === 'old') candidateCategories.push('male_old', 'male_middle');
        else if (a === 'young')
          candidateCategories.push('male_young', 'male_middle');
        else candidateCategories.push('male_middle', 'male_young', 'male_old');
      }
    } else {
      const haystack = [character.name ?? '', character.description ?? '']
        .join(' ')
        .toLowerCase();

      const isFemale = FEMALE_KEYWORDS.some((k) => haystack.includes(k));
      const isMale = MALE_KEYWORDS.some((k) => haystack.includes(k));
      const isOld = OLD_KEYWORDS.some((k) => haystack.includes(k));
      const isYoung = YOUNG_KEYWORDS.some((k) => haystack.includes(k));

      if (isFemale && isOld)
        candidateCategories.push('female_old', 'female_middle');
      else if (isFemale && isYoung)
        candidateCategories.push('female_young', 'female_middle');
      else if (isFemale)
        candidateCategories.push('female_middle', 'female_young', 'female_old');
      else if (isMale && isOld)
        candidateCategories.push('male_old', 'male_middle');
      else if (isMale && isYoung)
        candidateCategories.push('male_young', 'male_middle');
      else if (isMale)
        candidateCategories.push('male_middle', 'male_young', 'male_old');
    }

    candidateCategories.push('neutral');

    // First pass: most-preferred non-empty category that still has an UNUSED
    // voice. Probe forward from the round-robin offset so picks spread out.
    for (const category of candidateCategories) {
      const pool = this.voicePools[category];
      if (pool.length === 0) continue;

      const start = counters[category] % pool.length;
      for (let step = 0; step < pool.length; step++) {
        const idx = (start + step) % pool.length;
        if (!usedVoiceIds.has(pool[idx])) {
          counters[category] = idx + 1;
          return pool[idx];
        }
      }
    }

    // Second pass: every candidate pool is exhausted (more characters routed
    // here than distinct voices available). Reuse via round-robin from the
    // first non-empty candidate. Still deterministic.
    for (const category of candidateCategories) {
      const pool = this.voicePools[category];
      if (pool.length === 0) continue;
      const idx = counters[category] % pool.length;
      counters[category]++;
      return pool[idx];
    }

    // Ultimate fallback: no candidate category had any voice at all.
    if (this.allVoiceIds.length > 0) {
      return (
        this.allVoiceIds.find((v) => !usedVoiceIds.has(v)) ??
        this.allVoiceIds[0]
      );
    }

    return null;
  }
}
