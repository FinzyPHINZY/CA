/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures */
import { CursorCueDetectionService } from './cursor-cue-detection.service';
import { CursorStateService } from './cursor-state.service';
import type {
  CursorState,
  LineBucket,
  TurnWordRange,
} from './types/cue-engine.types';

describe('CursorCueDetectionService', () => {
  let service: CursorCueDetectionService;
  let cursorStateService: CursorStateService;
  let mockRedis: any;

  // helper to build a cursor state for a single actor turn
  function buildSingleTurnState(text: string, turnIndex = 0): CursorState {
    const contentWords = CursorStateService.extractContentWords(text);
    const lineBucket: LineBucket =
      contentWords.length <= 3
        ? 'short'
        : contentWords.length <= 7
          ? 'medium'
          : 'long';
    const tailSize =
      contentWords.length <= 0
        ? 0
        : lineBucket === 'short'
          ? 1
          : lineBucket === 'medium'
            ? Math.min(2, contentWords.length)
            : Math.min(3, contentWords.length);
    return {
      cursorPosition: 0,
      sceneContentWords: contentWords,
      turnWordRanges: {
        [turnIndex]: {
          start: 0,
          end: contentWords.length,
          totalContentWords: contentWords.length,
          tailStart:
            contentWords.length > 0 ? contentWords.length - tailSize : 0,
          tailEnd: contentWords.length,
          lineBucket,
        },
      },
      currentTurnMatchedCount: 0,
      currentTurnIndex: turnIndex,
      committedContentWords: [],
      lastProcessedContentWords: [],
    };
  }

  // helper to build a multi-turn state
  function buildMultiTurnState(
    turns: { index: number; text: string }[],
  ): CursorState {
    const sceneContentWords: string[] = [];
    const turnWordRanges: Record<number, TurnWordRange> = {};

    for (const turn of turns) {
      const start = sceneContentWords.length;
      const words = CursorStateService.extractContentWords(turn.text);
      const lineBucket: LineBucket =
        words.length <= 3 ? 'short' : words.length <= 7 ? 'medium' : 'long';
      const tailSize =
        words.length <= 0
          ? 0
          : lineBucket === 'short'
            ? 1
            : lineBucket === 'medium'
              ? Math.min(2, words.length)
              : Math.min(3, words.length);
      sceneContentWords.push(...words);
      turnWordRanges[turn.index] = {
        start,
        end: sceneContentWords.length,
        totalContentWords: words.length,
        tailStart:
          words.length > 0 ? sceneContentWords.length - tailSize : start,
        tailEnd: sceneContentWords.length,
        lineBucket,
      };
    }

    return {
      cursorPosition: 0,
      sceneContentWords,
      turnWordRanges,
      currentTurnMatchedCount: 0,
      currentTurnIndex: turns[0]?.index ?? 0,
      committedContentWords: [],
      lastProcessedContentWords: [],
    };
  }

  beforeEach(() => {
    mockRedis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };

    cursorStateService = new CursorStateService(mockRedis);
    service = new CursorCueDetectionService(cursorStateService);
  });

  // ─── THE CORE BUG FIX ──────────────────────────────────────────────

  describe('stop word immunity', () => {
    it('should NOT advance on single word "I"', async () => {
      const state = buildSingleTurnState(
        'I would love to keep saying yes and before I know it',
      );
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'I',
        0,
        'I would love to keep saying yes and before I know it',
        false,
        0.95,
      );

      expect(result.decision).toBe('none');
      expect(result.cursorPosition).toBe(0);
    });

    it('should NOT advance on multiple stop words "I do it"', async () => {
      const state = buildSingleTurnState('I would love to keep saying yes');
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'I do it',
        0,
        'I would love to keep saying yes',
        false,
        0.95,
      );

      expect(result.decision).toBe('none');
    });

    it('should NOT advance on "the"', async () => {
      const state = buildSingleTurnState(
        'The magnificent Constantinople stands tall',
      );
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'the',
        0,
        'The magnificent Constantinople stands tall',
        false,
        0.95,
      );

      expect(result.decision).toBe('none');
    });
  });

  // ─── CONTENT WORD MATCHING ──────────────────────────────────────────

  describe('content word cursor advancement', () => {
    it('should advance cursor when content words match in sequence', async () => {
      const state = buildSingleTurnState('I would love to keep saying yes');
      // content words: love, keep, saying, yes
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'I would love to keep saying yes',
        0,
        'I would love to keep saying yes',
        false,
        1.0,
      );

      expect(result.decision).toBe('advance');
      expect(result.matchRatio).toBe(1.0);
      expect(result.tailCoverage).toBe(true);
    });

    it('should return partial when some content words match', async () => {
      const state = buildSingleTurnState(
        'The magnificent Constantinople stands tall and proud tonight',
      );
      // content words: magnificent, constantinople, stands, tall, proud, tonight (6)
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'The magnificent Constantinople',
        0,
        'The magnificent Constantinople stands tall and proud tonight',
        false,
        0.95,
      );

      // 2 out of 6 content words matched = 0.33
      expect(result.decision).toBe('partial');
      expect(result.matchRatio).toBeGreaterThan(0.3);
      expect(result.matchRatio).toBeLessThan(0.6);
      expect(result.tailCoverage).toBe(false);
    });

    it('should handle skipped words within lookahead window', async () => {
      const state = buildSingleTurnState(
        'I really love Constantinople tonight',
      );
      // content words: really, love, constantinople, tonight
      cursorStateService.updateInMemory('reh-1', state);

      // actor says "love" (skipping "really") — should still match
      // because "love" is within the 5-word lookahead
      const result = await service.evaluate(
        'reh-1',
        'love',
        0,
        'I really love Constantinople tonight',
        false,
        0.95,
      );

      expect(result.cursorPosition).toBe(2); // past "really" and "love"
    });
  });

  describe('tail-aware completion', () => {
    it('should not advance a long line when only the front half is matched', async () => {
      const state = buildSingleTurnState(
        'I would love to keep saying yes and before I know it now tonight',
      );
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'I would love to keep saying yes',
        0,
        'I would love to keep saying yes and before I know it now tonight',
        false,
        0.95,
      );

      expect(result.lineBucket).toBe('long');
      expect(result.tailCoverage).toBe(false);
      expect(result.decision).toBe('partial');
    });

    it('should advance a long line once the tail section is reached with a strong final match', async () => {
      const state = buildSingleTurnState(
        'I would love to keep saying yes and before I know it now tonight',
      );
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'love keep saying yes before know now tonight',
        0,
        'I would love to keep saying yes and before I know it now tonight',
        false,
        0.95,
      );

      expect(result.lineBucket).toBe('long');
      expect(result.tailCoverage).toBe(true);
      expect(result.decision).toBe('advance');
    });
  });

  // ─── FORWARD-ONLY CONSTRAINT ────────────────────────────────────────

  describe('forward-only cursor', () => {
    it('should not move cursor backward', async () => {
      const state = buildSingleTurnState(
        'love Constantinople beautiful freedom',
      );
      state.cursorPosition = 2; // past "love" and "constantinople"
      state.currentTurnMatchedCount = 2;
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'love', // word behind cursor
        0,
        'love Constantinople beautiful freedom',
        false,
        0.95,
      );

      // cursor should not move back
      expect(result.cursorPosition).toBe(2);
    });
  });

  // ─── BACKWARD TOLERANCE + LOOKAHEAD WIDTH ───────────────────────────

  describe('backward tolerance', () => {
    it('credits a re-read of a forward-SKIPPED word behind the cursor without moving the cursor', async () => {
      // Simulate: actor said "Constantinople" first (skipping "love").
      // Cursor jumped to 2 to land on "Constantinople" but position 0
      // (love) was never credited — gap of 1.
      const state = buildSingleTurnState(
        'love Constantinople beautiful freedom',
      );
      state.cursorPosition = 2;
      state.currentTurnMatchedCount = 1; // only "Constantinople" credited
      cursorStateService.updateInMemory('reh-1', state);

      // Now actor backfills "love" — should credit it.
      const result = await service.evaluate(
        'reh-1',
        'love',
        0,
        'love Constantinople beautiful freedom',
        false,
        0.95,
      );

      // cursor stays — forward-only commit preserved
      expect(result.cursorPosition).toBe(2);
      // matched count bumps from 1 → 2 → matchRatio 2/4 = 0.5
      expect(result.matchRatio).toBeCloseTo(0.5, 2);
    });

    it('does NOT credit a re-read of an ALREADY-CREDITED position (skip-gap is zero)', async () => {
      // Cursor at 2, matched=2 — both prior positions already credited.
      // No gap → no backward credit even if the word matches behind.
      const state = buildSingleTurnState(
        'love Constantinople beautiful freedom',
      );
      state.cursorPosition = 2;
      state.currentTurnMatchedCount = 2;
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'love',
        0,
        'love Constantinople beautiful freedom',
        false,
        0.95,
      );

      expect(result.cursorPosition).toBe(2);
      // matchRatio stays at 2/4 = 0.5 — no double-counting
      expect(result.matchRatio).toBeCloseTo(0.5, 2);
    });

    it('does NOT credit a re-read more than BACKWARD_TOLERANCE words behind the cursor', async () => {
      // Set up a gap (skip-mode) so backward credit COULD fire if the
      // distance were within tolerance. Word is 5 positions behind — outside.
      const state = buildSingleTurnState(
        'love Constantinople beautiful freedom restaurant moonlight',
      );
      state.cursorPosition = 5;
      state.currentTurnMatchedCount = 1; // 4 positions skipped
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'love',
        0,
        'love Constantinople beautiful freedom restaurant moonlight',
        false,
        0.95,
      );

      expect(result.cursorPosition).toBe(5);
      // matched count unchanged at 1; matchRatio stays at 1/6
      expect(result.matchRatio).toBeCloseTo(1 / 6, 2);
    });
  });

  describe('drift detection', () => {
    it('returns decision=drift_reset on a final transcript when accumulated content is >2x expected with matchRatio < 0.4', async () => {
      const LINE =
        'love freedom tonight Constantinople beautiful evening moonlight';
      const state = buildSingleTurnState(LINE);
      cursorStateService.updateInMemory('reh-1', state);

      // 20 unrelated content words → well past 2x the 7-word expected,
      // matching ~0 of them against the line.
      const drift =
        'totally unrelated rambling about something completely different ' +
        'happening at the supermarket yesterday morning while shopping for ' +
        'groceries near the bakery section';

      const result = await service.evaluate(
        'reh-1',
        drift,
        0,
        LINE,
        false, // final
        0.9,
      );

      expect(result.decision).toBe('drift_reset');
      expect(result.matchRatio).toBeLessThan(0.4);
    });

    it('does NOT fire drift_reset on interim transcripts', async () => {
      const LINE =
        'love freedom tonight Constantinople beautiful evening moonlight';
      const state = buildSingleTurnState(LINE);
      cursorStateService.updateInMemory('reh-1', state);

      const drift =
        'totally unrelated rambling about something completely different ' +
        'happening at the supermarket yesterday morning while shopping for ' +
        'groceries near the bakery section';

      const result = await service.evaluate(
        'reh-1',
        drift,
        0,
        LINE,
        true, // interim
        0.9,
      );

      expect(result.decision).not.toBe('drift_reset');
    });

    it('does NOT fire drift_reset when matchRatio is healthy even on a long transcript', async () => {
      const LINE =
        'love freedom tonight Constantinople beautiful evening moonlight';
      const state = buildSingleTurnState(LINE);
      cursorStateService.updateInMemory('reh-1', state);

      // 15-word transcript hitting all 7 line words at the start.
      const transcript =
        'love freedom tonight Constantinople beautiful evening moonlight ' +
        'and then I kept talking about other unrelated things';

      const result = await service.evaluate(
        'reh-1',
        transcript,
        0,
        LINE,
        false,
        0.9,
      );

      expect(result.decision).not.toBe('drift_reset');
    });
  });

  describe('per-turn lookahead sizing', () => {
    it('lets a long-line read skip up to ~7 words ahead of the cursor', async () => {
      // 18 content words → long bucket → lookahead = min(8, ceil(18 * 0.4)) = 8
      const LINE =
        'love freedom moonlight Constantinople beautiful tomorrow yesterday ' +
        'evening morning afternoon midnight tonight sunset sunrise twilight ' +
        'horizon daybreak dusk';
      const state = buildSingleTurnState(LINE);
      cursorStateService.updateInMemory('reh-1', state);

      // skip the first 7 words and say the 8th — within widened lookahead
      const result = await service.evaluate(
        'reh-1',
        'evening',
        0,
        LINE,
        false,
        0.95,
      );

      // cursor should have advanced past the matched position
      expect(result.cursorPosition).toBeGreaterThan(0);
    });
  });

  // ─── SHORT LINE HANDLING ────────────────────────────────────────────

  describe('short lines', () => {
    it('should require exact match for 1-content-word lines', async () => {
      // "Absolutely" has 1 content word
      const state = buildSingleTurnState('Absolutely');
      cursorStateService.updateInMemory('reh-1', state);

      // partial word should not trigger
      const result1 = await service.evaluate(
        'reh-1',
        'I think',
        0,
        'Absolutely',
        false,
        0.95,
      );
      expect(result1.decision).toBe('none');

      // exact word should trigger
      const result2 = await service.evaluate(
        'reh-1',
        'Absolutely',
        0,
        'Absolutely',
        false,
        0.95,
      );
      expect(result2.decision).toBe('advance');
    });

    it('should advance 3-content-word line at 2/3 match (one miss tolerance)', async () => {
      // "We were just about to have dinner." → content words [just, about, dinner]
      // Speaking 2 of 3 correctly — matchRatio = 0.66 — must advance.
      const LINE = 'We were just about to have dinner.';
      const state = buildSingleTurnState(LINE);
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'just dinner',
        0,
        LINE,
        false,
        0.95,
      );

      expect(result.totalContentWords).toBe(3);
      expect(result.lineBucket).toBe('short');
      expect(result.matchRatio).toBeCloseTo(2 / 3, 2);
      expect(result.decision).toBe('advance');
    });

    it('should NOT advance 2-content-word line at 1/2 match (still requires exact)', async () => {
      // "love freedom" → content words [love, freedom], 2 words = tiny
      // Speaking 1 of 2 should remain partial (1.0 threshold).
      const state = buildSingleTurnState('love freedom');
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'love',
        0,
        'love freedom',
        false,
        0.95,
      );

      expect(result.totalContentWords).toBe(2);
      expect(result.lineBucket).toBe('short');
      expect(result.matchRatio).toBeCloseTo(0.5, 2);
      expect(result.decision).not.toBe('advance');
    });

    it('should advance 2-content-word line at 2/2 match', async () => {
      const state = buildSingleTurnState('love freedom');
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'love freedom',
        0,
        'love freedom',
        false,
        0.95,
      );

      expect(result.matchRatio).toBe(1.0);
      expect(result.decision).toBe('advance');
    });

    it('should handle stop-word-only lines via fallback', async () => {
      // "I do" → 0 content words after filtering
      const state: CursorState = {
        cursorPosition: 0,
        sceneContentWords: [],
        turnWordRanges: {
          0: {
            start: 0,
            end: 0,
            totalContentWords: 0,
            tailStart: 0,
            tailEnd: 0,
            lineBucket: 'short',
          },
        },
        currentTurnMatchedCount: 0,
        currentTurnIndex: 0,
        committedContentWords: [],
        lastProcessedContentWords: [],
      };
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'I do',
        0,
        'I do.',
        false,
        0.95,
      );

      expect(result.decision).toBe('advance');
      expect(result.tailCoverage).toBe(true);
    });
  });

  // ─── INTERIM VS FINAL TRANSCRIPTS ──────────────────────────────────

  describe('interim vs final transcript handling', () => {
    it('should not double-count words from interim then final', async () => {
      const state = buildSingleTurnState(
        'The magnificent Constantinople stands tall',
      );
      // content words: magnificent, constantinople, stands, tall (4)
      cursorStateService.updateInMemory('reh-1', state);

      // interim with first 2 content words
      await service.evaluate(
        'reh-1',
        'The magnificent Constantinople',
        0,
        'The magnificent Constantinople stands tall',
        true, // interim
        1.0,
      );

      // final with same words — should not double-count
      const result = await service.evaluate(
        'reh-1',
        'The magnificent Constantinople',
        0,
        'The magnificent Constantinople stands tall',
        false, // final
        1.0,
      );

      // should be 2/4 = 0.5, not 4/4 = 1.0
      expect(result.matchRatio).toBe(0.5);
    });

    it('should require higher confidence for interim advance', async () => {
      const state = buildSingleTurnState('I love Constantinople tonight');
      // content words: love, constantinople, tonight (3)
      // medium threshold = 0.50
      cursorStateService.updateInMemory('reh-1', state);

      // low confidence interim — should not advance even with good match
      const result = await service.evaluate(
        'reh-1',
        'love Constantinople',
        0,
        'I love Constantinople tonight',
        true, // interim
        0.7, // below 0.90 threshold
      );

      expect(result.decision).not.toBe('advance');
    });
  });

  // ─── MULTI-TURN SCENE ──────────────────────────────────────────────

  describe('multi-turn scene tracking', () => {
    it('should track cursor across multiple actor turns', async () => {
      const state = buildMultiTurnState([
        { index: 0, text: 'I love Constantinople' },
        { index: 2, text: 'Beautiful freedom tonight' },
      ]);
      cursorStateService.updateInMemory('reh-1', state);

      // complete first turn
      const r1 = await service.evaluate(
        'reh-1',
        'love Constantinople',
        0,
        'I love Constantinople',
        false,
        0.95,
      );
      expect(r1.decision).toBe('advance');

      // cursor should now be past turn 0's words
      const updated = await cursorStateService.getCursorState('reh-1');
      expect(updated!.cursorPosition).toBe(2); // past "love", "constantinople"
    });
  });

  // ─── NULL / MISSING STATE ──────────────────────────────────────────

  describe('edge cases', () => {
    it('should return none when cursor state is missing', async () => {
      const result = await service.evaluate(
        'nonexistent',
        'hello world',
        0,
        'hello world',
        false,
        0.95,
      );

      expect(result.decision).toBe('none');
      expect(result.matchRatio).toBe(0);
    });

    it('should return none for empty transcript', async () => {
      const state = buildSingleTurnState('Hello beautiful world');
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        '',
        0,
        'Hello beautiful world',
        false,
        0.95,
      );

      expect(result.decision).toBe('none');
    });

    it('should handle cursor past turn range as advance', async () => {
      const state = buildSingleTurnState('love freedom');
      state.cursorPosition = 2; // past the end of the turn (end = 2)
      state.currentTurnMatchedCount = 2;
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'anything',
        0,
        'love freedom',
        false,
        0.95,
      );

      expect(result.decision).toBe('advance');
    });
  });

  // ─── CONFIDENCE WEIGHTING + LOWERED THRESHOLDS (W3) ────────────────
  describe('confidence weighting', () => {
    // 11 content words → long bucket, advance threshold = 0.70
    const LONG_LINE =
      'followed that fish upriver downriver three days three nights cornered him';

    it('match ratio is independent of Deepgram confidence on final transcripts', async () => {
      const state = buildSingleTurnState(LONG_LINE);
      cursorStateService.updateInMemory('reh-1', state);

      // speak the entire line at modest confidence (typical accented read)
      const result = await service.evaluate(
        'reh-1',
        LONG_LINE,
        0,
        LONG_LINE,
        false,
        0.7,
      );

      // confidence no longer deflates the numerator — a full match is 1.0
      // regardless of the confidence score. Confidence is still used as a
      // gate on interim advance/partial, just not as a multiplier.
      expect(result.matchRatio).toBeCloseTo(1.0, 2);
      expect(result.decision).toBe('advance');
    });

    it('high-confidence full read advances on a long line at the new 0.70 threshold', async () => {
      const state = buildSingleTurnState(LONG_LINE);
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        LONG_LINE,
        0,
        LONG_LINE,
        false,
        1.0,
      );

      expect(result.decision).toBe('advance');
      expect(result.matchRatio).toBe(1.0);
    });

    it('long line with ~75% words matched at 0.95 confidence advances (was blocked at old 0.85)', async () => {
      // 12 content words; speak 9 of them → 9/12 = 0.75
      const line =
        'followed that fish upriver downriver three days three nights cornered him completely';
      const state = buildSingleTurnState(line);
      cursorStateService.updateInMemory('reh-1', state);

      // 9 words spoken correctly, including the tail words for tailCoverage
      const spoken =
        'followed fish downriver three days three nights cornered completely';
      const result = await service.evaluate(
        'reh-1',
        spoken,
        0,
        line,
        false,
        0.95,
      );

      // 9 × 0.95 / 12 ≈ 0.7125, just over the new 0.70 threshold
      expect(result.matchRatio).toBeGreaterThanOrEqual(0.7);
      expect(result.tailCoverage).toBe(true);
      expect(result.decision).toBe('advance');
    });

    it('long line at 60% match still does not advance regardless of confidence', async () => {
      const line =
        'followed that fish upriver downriver three days three nights cornered him';
      const state = buildSingleTurnState(line);
      cursorStateService.updateInMemory('reh-1', state);

      // only 6 of 11 content words
      const spoken = 'followed fish upriver downriver three days';
      const result = await service.evaluate(
        'reh-1',
        spoken,
        0,
        line,
        false,
        1.0,
      );

      // 6/11 ≈ 0.545 < 0.70 threshold
      expect(result.matchRatio).toBeLessThan(0.7);
      expect(result.decision).not.toBe('advance');
    });
  });

  // ─── REWIND BASELINE (post cue.back / retry) ───────────────────────
  // Regression: after a rewind, Deepgram's interim transcript still contains
  // words spoken before the rewind. Without the baseline-swallow, those stale
  // words walk the cursor forward through false matches and poison every
  // subsequent event. The first post-rewind event must be absorbed as a
  // baseline (no cursor movement), and only words appended after it count.
  describe('rewind baseline', () => {
    const LINE = 'I followed that fish up river for three days and nights';

    it('absorbs the first post-rewind transcript as baseline (no cursor advance)', async () => {
      const state = buildSingleTurnState(LINE);
      // simulate prior progress before the rewind
      state.cursorPosition = 4;
      state.currentTurnMatchedCount = 4;
      state.committedContentWords = ['follow', 'fish', 'river', 'three'];
      state.lastProcessedContentWords = ['follow', 'fish', 'river', 'three'];
      // user hits cue.back → resetCursorForTurn rewinds and arms the flag
      state.cursorPosition = 0;
      state.currentTurnMatchedCount = 0;
      state.committedContentWords = [];
      state.lastProcessedContentWords = [];
      state.pendingRewindBaseline = true;
      cursorStateService.updateInMemory('reh-1', state);

      // Deepgram delivers a stale interim containing the OLD speech
      const stale = 'followed that fish up river for three';
      const result = await service.evaluate('reh-1', stale, 0, LINE, true, 0.9);

      expect(result.decision).toBe('none');
      expect(result.cursorPosition).toBe(0);

      const after = await cursorStateService.getCursorState('reh-1');
      expect(after?.pendingRewindBaseline).toBe(false);
      expect(after?.currentTurnMatchedCount).toBe(0);
      // baseline absorbed — these words should be ignored next time
      expect(after?.lastProcessedContentWords.length).toBeGreaterThan(0);
    });

    it('only counts words appended after the baseline event', async () => {
      const state = buildSingleTurnState(LINE);
      state.pendingRewindBaseline = true;
      cursorStateService.updateInMemory('reh-1', state);

      // first event after rewind = stale buffer (absorbed)
      const stale = 'followed that fish up river for three';
      await service.evaluate('reh-1', stale, 0, LINE, true, 0.9);

      // second event = stale buffer + freshly spoken "days nights"
      const fresh = 'followed that fish up river for three days nights';
      const result = await service.evaluate('reh-1', fresh, 0, LINE, true, 0.9);

      // only "days" and "nights" should advance the cursor — not the 5 stale
      // content words from the baseline
      const after = await cursorStateService.getCursorState('reh-1');
      expect(after?.currentTurnMatchedCount).toBeLessThanOrEqual(2);
      expect(result.cursorPosition).toBeLessThanOrEqual(
        state.sceneContentWords.length,
      );
    });

    it('consecutive rewinds each consume one baseline event', async () => {
      const state = buildSingleTurnState(LINE);
      state.pendingRewindBaseline = true;
      cursorStateService.updateInMemory('reh-1', state);

      await service.evaluate(
        'reh-1',
        'followed fish river',
        0,
        LINE,
        true,
        0.9,
      );
      let after = await cursorStateService.getCursorState('reh-1');
      expect(after?.pendingRewindBaseline).toBe(false);

      // second rewind re-arms
      await cursorStateService.resetCursorForTurn('reh-1', 0);
      after = await cursorStateService.getCursorState('reh-1');
      expect(after?.pendingRewindBaseline).toBe(true);

      // next event swallowed again
      const result = await service.evaluate(
        'reh-1',
        'followed fish river days',
        0,
        LINE,
        true,
        0.9,
      );
      expect(result.decision).toBe('none');
      expect(result.cursorPosition).toBe(0);
      after = await cursorStateService.getCursorState('reh-1');
      expect(after?.pendingRewindBaseline).toBe(false);
    });
  });

  // ─── FORWARD PROGRESSION (NO BASELINE SWALLOW) ─────────────────────
  // Regression: on a clean forward actor turn (no rewind), the first
  // transcript event must count normally. Previously resetForNewTurn armed
  // pendingRewindBaseline, which threw away the first event — devastating
  // on short lines where the first interim carried most of the content.
  describe('forward progression (no baseline swallow)', () => {
    it('counts words from the first interim of a fresh actor turn', async () => {
      const state = buildSingleTurnState('We were just about to have dinner.');
      // resetForNewTurn-style: forward progression. pendingRewindBaseline
      // should NOT be set — verify by feeding a matching interim and
      // expecting immediate cursor movement.
      expect(state.pendingRewindBaseline).toBeFalsy();
      cursorStateService.updateInMemory('reh-1', state);

      const result = await service.evaluate(
        'reh-1',
        'We were just about',
        0,
        'We were just about to have dinner.',
        true, // interim
        0.97,
      );

      // content words [just, about, dinner]; interim captured 2 of 3.
      // Before the fix this returned decision 'none' with matchRatio 0
      // because the whole event was swallowed as baseline.
      const after = await cursorStateService.getCursorState('reh-1');
      expect(after?.currentTurnMatchedCount).toBe(2);
      expect(result.matchRatio).toBeCloseTo(2 / 3, 2);
    });

    it('replays the reported bug: interim "just about" + final "just able to have dinner" advances', async () => {
      // Exact sequence from the bug report: transcription error "about" → "able"
      // on a short line. The interim's 2 matched content words plus the
      // final's dinner should reach 3/3 = 1.0 and advance.
      const LINE = 'We were just about to have dinner.';
      const state = buildSingleTurnState(LINE);
      cursorStateService.updateInMemory('reh-1', state);

      // interim 1: "We were just about" → matches just + about
      await service.evaluate(
        'reh-1',
        'We were just about',
        0,
        LINE,
        true,
        0.979,
      );

      // final: "We were just able to have dinner" → able rejects (edit
      // distance > 1 vs about), dinner matches
      const result = await service.evaluate(
        'reh-1',
        'We were just able to have dinner',
        0,
        LINE,
        false,
        0.999,
      );

      const after = await cursorStateService.getCursorState('reh-1');
      expect(after?.currentTurnMatchedCount).toBe(3);
      expect(result.matchRatio).toBeCloseTo(1.0, 2);
      expect(result.decision).toBe('advance');
    });
  });
});
