/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

// Wraps Deepgram Management API for scoped session key lifecycle.
// Master DEEPGRAM_API_KEY is never returned to the client.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CursorStateService } from './cursor-state.service';
import type { CueTurn } from './types/cue-engine.types';

const DEEPGRAM_BASE = 'https://api.deepgram.com/v1';

export interface DeepgramSessionKey {
  keyId: string;
  apiKey: string;
}

export interface DeepgramConfig {
  model: string;
  language: string;
  punctuate: boolean;
  smart_format: boolean;
  interim_results: boolean;
  endpointing: number;
  /**
   * Nova-2 keyword boosting. Plain `word:boost` pairs that bias recognition
   * toward script vocabulary. Recommended ceiling ~3.0 — higher values lead
   * to hallucinations on words the actor didn't say.
   */
  keywords?: string[];
  /**
   * Nova-3 keyterm prompting. Plain word strings (no boost suffix). Higher
   * precision than Nova-2's `keywords` parameter — designed for per-utterance
   * term injection.
   */
  keyterm?: string[];
}

@Injectable()
export class DeepgramService {
  private readonly logger = new Logger(DeepgramService.name);
  private readonly masterApiKey: string;
  private readonly projectId: string;
  private readonly endpointingMs: number;
  /** Deepgram model id — driven by DEEPGRAM_MODEL env (defaults to nova-2). */
  readonly model: string;
  /** True when the configured model uses `keyterm` rather than `keywords`. */
  readonly usesKeyterm: boolean;

  constructor(private readonly configService: ConfigService) {
    this.masterApiKey =
      this.configService.getOrThrow<string>('DEEPGRAM_API_KEY');
    this.projectId = this.configService.getOrThrow<string>(
      'DEEPGRAM_PROJECT_ID',
    );
    // Deepgram `endpointing` (milliseconds of silence Deepgram waits before
    // emitting an is_final event). Pre-2026 default was 1000ms; lowered to
    // 300ms — the conversational-AI industry standard (matches Pipecat,
    // LiveKit Agents, OpenAI Realtime). Largest single perceived-speed win
    // on cache-hit Hazel turns. Tunable via env without redeploy.
    this.endpointingMs = this.configService.get<number>(
      'DEEPGRAM_ENDPOINTING_MS',
      300,
    );
    // Deepgram model. `nova-2` keeps the legacy `keywords:boost` term
    // boosting. `nova-3` switches to the higher-precision `keyterm`
    // parameter — better accuracy on accented English and term recall.
    // Flag-controlled rollout: default nova-2, flip to nova-3 after
    // staging A/B confirms accuracy.
    this.model = this.configService.get<string>('DEEPGRAM_MODEL', 'nova-2');
    this.usesKeyterm = this.model.startsWith('nova-3');
  }

  // create a scoped, short-lived session key for browser-direct Deepgram connection.
  // only `usage:write` scope — cannot manage keys or access billing.
  async createSessionKey(
    rehearsalId: string,
    ttlSeconds: number = 7200,
  ): Promise<DeepgramSessionKey> {
    const response = await axios.post(
      `${DEEPGRAM_BASE}/projects/${this.projectId}/keys`,
      {
        comment: `hazel-session:${rehearsalId}`,
        scopes: ['usage:write'],
        expiration_date: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      },
      {
        headers: {
          Authorization: `Token ${this.masterApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    const data = response.data as any;
    const keyId = data.api_key_id ?? data.key_id;
    this.logger.log(
      `Deepgram session key created for rehearsal ${rehearsalId}: ${keyId}`,
    );

    return {
      keyId,
      apiKey: data.key,
    };
  }

  // revoke a session key. Called on session end to prevent post-session reuse
  async revokeKey(keyId: string): Promise<void> {
    try {
      await axios.delete(
        `${DEEPGRAM_BASE}/projects/${this.projectId}/keys/${keyId}`,
        {
          headers: { Authorization: `Token ${this.masterApiKey}` },
          timeout: 10_000,
        },
      );
      this.logger.log(`Deepgram key revoked: ${keyId}`);
    } catch (err: any) {
      this.logger.warn(
        `Failed to revoke Deepgram key ${keyId}: ${err.message}`,
      );
    }
  }

  getRecommendedConfig(keywords?: string[]): DeepgramConfig {
    const config: DeepgramConfig = {
      model: this.model,
      language: 'en',
      punctuate: true,
      smart_format: true,
      interim_results: true,
      endpointing: this.endpointingMs,
    };

    if (keywords?.length) {
      if (this.usesKeyterm) {
        // Nova-3: strip the `:boost` suffix — keyterm is plain words.
        config.keyterm = keywords.map((kw) => {
          const idx = kw.indexOf(':');
          return idx >= 0 ? kw.slice(0, idx) : kw;
        });
      } else {
        config.keywords = keywords;
      }
    }

    return config;
  }

  /**
   * Extract unique content words from script lines to use as Deepgram keyword hints.
   * Words are deduplicated and formatted as "word:boost" pairs.
   * Deepgram uses these to bias its speech recognition toward script vocabulary.
   *
   * @param lines - Array of script line strings
   * @param boost - Boost intensity (default 1.5, range roughly 0.5-3.0)
   * @returns Array of "word:boost" strings, capped at 100 entries (Deepgram limit)
   */
  buildKeywordHints(lines: string[], boost: number = 1.5): string[] {
    const wordFreq = new Map<string, number>();

    for (const line of lines) {
      const words = line
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 2); // skip tiny words

      for (const w of words) {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      }
    }

    // sort by frequency (most common script words get priority)
    const sorted = [...wordFreq.entries()].sort((a, b) => b[1] - a[1]);

    // cap at 100 keywords (Deepgram's practical limit)
    return sorted.slice(0, 100).map(([word]) => `${word}:${boost}`);
  }

  /**
   * Build a focused, per-turn keyword boost window for Deepgram.
   *
   * Unlike `buildKeywordHints` (which produces a static scene-wide hint set
   * at session start), this returns the words the *actor* is most likely to
   * say in the immediate future: the current turn (if actor) plus the next
   * `lookaheadActorTurns` actor turns. Hazel turns and action/parenthetical
   * blocks are skipped — only what the actor actually has to read.
   *
   * Stop words are stripped via the same list cue detection uses.
   * Single-character words are dropped (Deepgram boost is meaningless on them),
   * but short proper nouns like "Per", "Ed", "Jim" ARE kept — those are exactly
   * the words that get mis-transcribed and most need boosting.
   *
   * The current turn is boosted HIGHER than the lookahead turns so the line
   * the actor is about to read dominates over upcoming vocabulary. This keeps
   * a small lookahead safety net without letting future lines poison the
   * current recognition.
   *
   * @param turns                 - Full turn sequence for the rehearsal
   * @param fromIndex             - Current turn index (where the cursor is)
   * @param lookaheadActorTurns   - How many upcoming actor turns to include
   * @param currentBoost          - Boost weight for words in the current turn
   * @param lookaheadBoost        - Boost weight for words in lookahead turns
   * @param speakableType         - Which turn kind counts as "actor" for the
   *                                lookahead walk. Defaults to 'actor' for
   *                                Hazel; teleprompter passes 'line'.
   */
  buildKeywordWindow(
    turns: CueTurn[],
    fromIndex: number,
    lookaheadActorTurns: number = 1,
    currentBoost: number = 3.0,
    lookaheadBoost: number = 1.5,
    speakableType: string = 'actor',
  ): string[] {
    if (!turns?.length || fromIndex < 0 || fromIndex >= turns.length) {
      return [];
    }

    // collect (text, boost) pairs so current-turn words get their higher
    // weight even though they're emitted in the same flat list
    const collected: Array<{ text: string; boost: number }> = [];
    let actorTurnsSeen = 0;

    const currentTurn = turns[fromIndex];
    if (currentTurn?.type === speakableType) {
      collected.push({ text: currentTurn.text, boost: currentBoost });
      actorTurnsSeen = 1;
    }

    for (
      let i = fromIndex + 1;
      i < turns.length && actorTurnsSeen <= lookaheadActorTurns;
      i++
    ) {
      const t = turns[i];
      if (t?.type !== speakableType) continue;
      collected.push({ text: t.text, boost: lookaheadBoost });
      actorTurnsSeen++;
      if (actorTurnsSeen > lookaheadActorTurns) break;
    }

    if (collected.length === 0) return [];

    // extract non-stemmed content words (Deepgram needs real spellings).
    // current-turn words come first, so if the same word also appears in a
    // lookahead turn the higher current-turn boost is what gets emitted.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const { text, boost } of collected) {
      const words = CursorStateService.extractContentWords(text, false);
      for (const w of words) {
        if (w.length < 2) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        out.push(`${w}:${boost}`);
        if (out.length >= 50) return out;
      }
    }

    return out;
  }

  /**
   * Decide whether the frontend should reconnect its Deepgram socket with a
   * new keyword list, given the previously-emitted keyword list.
   *
   * Reconnects are expensive: on actor→actor transitions the socket close/open
   * window can clip the first word of the next line. If two consecutive turns
   * have nearly-identical keyword lists (common for dialogue in the same
   * beat, sharing vocabulary), there's no value in reconnecting — the
   * current socket's boost bias is already "close enough" for the next turn.
   *
   * Uses Jaccard similarity on the bare words (ignoring `:boost` suffixes)
   * and returns `true` only when similarity is BELOW the threshold, i.e.
   * the keyword set has meaningfully shifted and a reconnect is warranted.
   *
   * Edge cases:
   *   - Empty `previous` (session start, or cleared) → always reconnect
   *   - Empty `next` → never reconnect (no new hints to apply)
   *   - Identical sets → never reconnect (similarity 1.0)
   *
   * @param previous             - Last keyword list we emitted
   * @param next                 - Freshly computed keyword list for the upcoming turn
   * @param similarityThreshold  - Minimum Jaccard overlap to skip reconnect (default 0.7)
   * @returns true if the frontend should reconnect with `next`
   */
  shouldReconnectForKeywordChange(
    previous: string[] | null | undefined,
    next: string[],
    similarityThreshold: number = 0.7,
  ): boolean {
    if (!next.length) return false;
    if (!previous || !previous.length) return true;

    const stripBoost = (kw: string): string => {
      const idx = kw.indexOf(':');
      return idx >= 0 ? kw.slice(0, idx) : kw;
    };

    const prevSet = new Set(previous.map(stripBoost));
    const nextSet = new Set(next.map(stripBoost));

    let intersection = 0;
    for (const w of nextSet) {
      if (prevSet.has(w)) intersection++;
    }
    const unionSize = prevSet.size + nextSet.size - intersection;
    if (unionSize === 0) return false;

    const jaccard = intersection / unionSize;
    return jaccard < similarityThreshold;
  }
}
