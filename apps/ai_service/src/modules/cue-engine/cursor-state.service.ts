// cursor state service — manages the sliding window cursor's lifecycle in Redis
// and an in-memory cache for hot-path performance.
//
// Redis key: hazel:{rehearsalId}:cursor (TTL: 4h, matching session TTL).
// In-memory Map avoids Redis round-trips on every transcript event (~200ms intervals).
// Syncs to Redis on final transcripts and state-changing events (advance, jump, back).

import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import type {
  LineBucket,
  CueTurn,
  CursorState,
  TurnWordRange,
} from './types/cue-engine.types';
import { stemWord } from './fuzzy-match.util';

const CURSOR_TTL_SECONDS = 4 * 60 * 60; // 4 hours

// Contraction expansion map. Applied BEFORE punctuation stripping so that
// script text ("You're what?") and Deepgram transcripts ("You are what?")
// produce the same token stream. Without this, "you're" becomes the phantom
// token "youre" after punctuation is stripped — which isn't in STOP_WORDS
// and almost never appears in Deepgram output, so it poisons match ratios
// on lines with contractions.
//
// Negations (can't, won't, don't, etc.) are still handled by their stripped
// forms being in STOP_WORDS, but expanding them here is cleaner and covers
// the affirmative forms that weren't previously covered at all.
const CONTRACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bi'm\b/gi, 'i am'],
  [/\bi've\b/gi, 'i have'],
  [/\bi'll\b/gi, 'i will'],
  [/\bi'd\b/gi, 'i would'],
  [/\byou're\b/gi, 'you are'],
  [/\byou've\b/gi, 'you have'],
  [/\byou'll\b/gi, 'you will'],
  [/\byou'd\b/gi, 'you would'],
  [/\bhe's\b/gi, 'he is'],
  [/\bhe'll\b/gi, 'he will'],
  [/\bhe'd\b/gi, 'he would'],
  [/\bshe's\b/gi, 'she is'],
  [/\bshe'll\b/gi, 'she will'],
  [/\bshe'd\b/gi, 'she would'],
  [/\bit's\b/gi, 'it is'],
  [/\bit'll\b/gi, 'it will'],
  [/\bit'd\b/gi, 'it would'],
  [/\bwe're\b/gi, 'we are'],
  [/\bwe've\b/gi, 'we have'],
  [/\bwe'll\b/gi, 'we will'],
  [/\bwe'd\b/gi, 'we would'],
  [/\bthey're\b/gi, 'they are'],
  [/\bthey've\b/gi, 'they have'],
  [/\bthey'll\b/gi, 'they will'],
  [/\bthey'd\b/gi, 'they would'],
  [/\bthat's\b/gi, 'that is'],
  [/\bthat'll\b/gi, 'that will'],
  [/\bthere's\b/gi, 'there is'],
  [/\bthere'll\b/gi, 'there will'],
  [/\bhere's\b/gi, 'here is'],
  [/\bwhat's\b/gi, 'what is'],
  [/\bwhere's\b/gi, 'where is'],
  [/\bwho's\b/gi, 'who is'],
  [/\bhow's\b/gi, 'how is'],
  [/\blet's\b/gi, 'let us'],
  // negations — also handled by STOP_WORDS on the stripped form, but
  // expanding keeps the aux verb visible where it matters
  [/\bcan't\b/gi, 'can not'],
  [/\bwon't\b/gi, 'will not'],
  [/\bdon't\b/gi, 'do not'],
  [/\bdoesn't\b/gi, 'does not'],
  [/\bdidn't\b/gi, 'did not'],
  [/\bisn't\b/gi, 'is not'],
  [/\baren't\b/gi, 'are not'],
  [/\bwasn't\b/gi, 'was not'],
  [/\bweren't\b/gi, 'were not'],
  [/\bhasn't\b/gi, 'has not'],
  [/\bhaven't\b/gi, 'have not'],
  [/\bhadn't\b/gi, 'had not'],
  [/\bwouldn't\b/gi, 'would not'],
  [/\bcouldn't\b/gi, 'could not'],
  [/\bshouldn't\b/gi, 'should not'],
  [/\bmightn't\b/gi, 'might not'],
  [/\bmustn't\b/gi, 'must not'],
];

function expandContractions(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CONTRACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Stop words for cursor-based cue detection.
//
// IMPORTANT: This list is intentionally LEAN for dialogue matching.
// Only true function words (articles, prepositions, conjunctions, pronouns,
// auxiliaries) belong here. DO NOT add verbs, interjections, or any word
// that could carry meaning in a script line — those are matching signal.
//
// Previously included "go", "get", "come", "say", "tell", "make", "take",
// "see", "know", "think", "want", "need", "hey", "oh", "well", "yeah",
// "yes", "right", "like", "here", "there", "now", "then" etc.
// These were removed because they appear in script dialogue and stripping
// them destroys matching signal (e.g., "Hey, what's cookin'?" lost "hey").
const STOP_WORDS: ReadonlySet<string> = new Set([
  // pronouns
  'i',
  'me',
  'my',
  'mine',
  'myself',
  'we',
  'us',
  'our',
  'ours',
  'you',
  'your',
  'yours',
  'yourself',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'it',
  'its',
  'they',
  'them',
  'their',
  'theirs',
  // articles
  'a',
  'an',
  'the',
  // auxiliaries / modals
  'is',
  'are',
  'was',
  'were',
  'am',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'dont',
  'doesnt',
  'didnt',
  'have',
  'has',
  'had',
  'having',
  'will',
  'would',
  'could',
  'should',
  'can',
  'may',
  'might',
  'shall',
  'wont',
  'wouldnt',
  'couldnt',
  'shouldnt',
  'cant',
  // prepositions
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'into',
  'through',
  // conjunctions
  'if',
  'or',
  'and',
  'but',
  'nor',
  'so',
  'as',
  'than',
  // determiners / quantifiers
  'that',
  'this',
  'these',
  'those',
  'each',
  'every',
  'both',
  'some',
  'any',
  // filler sounds (not words — genuinely meaningless)
  'um',
  'uh',
]);

@Injectable()
export class CursorStateService {
  private readonly logger = new Logger(CursorStateService.name);

  // in-memory cache for hot-path performance
  private readonly cache = new Map<string, CursorState>();

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /** Check if a word is a stop word. */
  static isStopWord(word: string): boolean {
    return STOP_WORDS.has(word);
  }

  /** Extract content words (non-stop-words) from text, with optional stemming. */
  static extractContentWords(text: string, applyStemming = true): string[] {
    const words = expandContractions(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w));

    return applyStemming ? words.map(stemWord) : words;
  }

  /** Normalize text to lowercase words array (including stop words). */
  static normalizeWords(text: string): string[] {
    return expandContractions(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
  }

  /**
   * Build the scene content word index from a CueTurn[] array.
   * Called once at session start after building the turn sequence.
   * `speakableType` filters which turn kinds participate in cursor tracking
   * (Hazel: 'actor'; teleprompter: 'line'). Defaults to 'actor' for
   * backward compatibility with Hazel callers.
   */
  async buildSceneIndex(
    rehearsalId: string,
    turns: CueTurn[],
    speakableType: string = 'actor',
  ): Promise<CursorState> {
    const sceneContentWords: string[] = [];
    const turnWordRanges: Record<number, TurnWordRange> = {};

    for (const turn of turns) {
      // only speakable turns participate in cursor tracking
      if (turn.type !== speakableType) continue;

      const startIdx = sceneContentWords.length;
      const contentWords = CursorStateService.extractContentWords(turn.text);
      sceneContentWords.push(...contentWords);
      const lineBucket = this.getLineBucket(contentWords.length);
      const tailSize = this.getTailSize(lineBucket, contentWords.length);
      const tailStart =
        contentWords.length > 0
          ? sceneContentWords.length - tailSize
          : sceneContentWords.length;

      turnWordRanges[turn.index] = {
        start: startIdx,
        end: sceneContentWords.length,
        totalContentWords: contentWords.length,
        tailStart,
        tailEnd: sceneContentWords.length,
        lineBucket,
      };
    }

    const state: CursorState = {
      cursorPosition: 0,
      sceneContentWords,
      turnWordRanges,
      currentTurnMatchedCount: 0,
      currentTurnIndex: -1,
      committedContentWords: [],
      lastProcessedContentWords: [],
      pendingRewindBaseline: false,
    };

    this.cache.set(rehearsalId, state);
    await this.persistToRedis(rehearsalId, state);

    this.logger.log(
      `Cursor index built for ${rehearsalId}: ${sceneContentWords.length} content words across ${Object.keys(turnWordRanges).length} actor turns`,
    );

    return state;
  }

  /** Get cursor state — from cache first, then Redis. */
  async getCursorState(rehearsalId: string): Promise<CursorState | null> {
    const cached = this.cache.get(rehearsalId);
    if (cached) return cached;

    const raw = await this.redis.get(this.cursorKey(rehearsalId));
    if (!raw) return null;

    const state = JSON.parse(raw) as CursorState;
    this.cache.set(rehearsalId, state);
    return state;
  }

  /** Update cursor state in-memory. Call persistToRedis() separately when needed. */
  updateInMemory(rehearsalId: string, state: CursorState): void {
    this.cache.set(rehearsalId, state);
  }

  /** Persist cursor state to Redis (call on final transcripts and state changes). */
  async persistToRedis(rehearsalId: string, state: CursorState): Promise<void> {
    await this.redis.set(
      this.cursorKey(rehearsalId),
      JSON.stringify(state),
      'EX',
      CURSOR_TTL_SECONDS,
    );
  }

  /** Sync the in-memory state to Redis. */
  async syncToRedis(rehearsalId: string): Promise<void> {
    const state = this.cache.get(rehearsalId);
    if (state) {
      await this.persistToRedis(rehearsalId, state);
    }
  }

  /**
   * Reset cursor position to the start of a specific turn's word range.
   * Called on cue.back and session.jump_to.
   */
  async resetCursorForTurn(
    rehearsalId: string,
    turnIndex: number,
  ): Promise<void> {
    const state = await this.getCursorState(rehearsalId);
    if (!state) return;

    const range = state.turnWordRanges[turnIndex];
    if (range) {
      state.cursorPosition = range.start;
      state.currentTurnMatchedCount = 0;
    }
    state.currentTurnIndex = turnIndex;
    state.committedContentWords = [];
    state.lastProcessedContentWords = [];
    state.pendingRewindBaseline = true;

    this.cache.set(rehearsalId, state);
    await this.persistToRedis(rehearsalId, state);
  }

  /**
   * Reset transcript tracking for a new actor turn without moving the cursor position.
   * Called when a new actor turn begins — the cursor position persists across turns
   * (it's scene-scoped), but the matched count and transcript dedup state reset.
   *
   * NOTE: pendingRewindBaseline is intentionally NOT touched here. Forward turn
   * progression has clean state — the cursor is past prior turn content (so stale
   * words can't advance it; findInWindow only looks forward), and the session
   * transcript buffer was just atomically cleared in setCurrentTurn. Baseline
   * swallowing was actively harmful on short lines because it threw away the
   * first clean interim of every turn. Rewind/retry paths still set baseline
   * explicitly via resetCursorForTurn.
   */
  async resetForNewTurn(rehearsalId: string, turnIndex: number): Promise<void> {
    const state = await this.getCursorState(rehearsalId);
    if (!state) return;

    state.currentTurnIndex = turnIndex;
    state.currentTurnMatchedCount = 0;
    state.committedContentWords = [];
    state.lastProcessedContentWords = [];

    this.cache.set(rehearsalId, state);
    // no Redis sync needed — will sync on next final transcript
  }

  /**
   * Clear transcript dedup tracking without resetting cursor position or
   * matched count. Used by the gateway's quiet-reset timer: after a partial
   * stagnates (actor paused mid-attempt), we want the next transcript to be
   * treated as fresh Deepgram input rather than being deduped against stale
   * interim text, but the actor's correctly-spoken words so far should still
   * count toward the line.
   */
  async clearDedupForRetry(rehearsalId: string): Promise<void> {
    const state = await this.getCursorState(rehearsalId);
    if (!state) return;
    state.committedContentWords = [];
    state.lastProcessedContentWords = [];
    this.cache.set(rehearsalId, state);
  }

  /** Clean up state for a session. */
  cleanup(rehearsalId: string): void {
    this.cache.delete(rehearsalId);
  }

  private cursorKey(rehearsalId: string): string {
    return `hazel:${rehearsalId}:cursor`;
  }

  private getLineBucket(wordCount: number): LineBucket {
    if (wordCount <= 3) return 'short';
    if (wordCount <= 7) return 'medium';
    return 'long';
  }

  private getTailSize(lineBucket: LineBucket, wordCount: number): number {
    if (wordCount <= 0) return 0;
    if (lineBucket === 'short') return 1;
    if (lineBucket === 'medium') return Math.min(2, wordCount);
    return Math.min(3, wordCount);
  }
}
