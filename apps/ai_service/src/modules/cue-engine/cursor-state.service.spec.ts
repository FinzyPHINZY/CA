/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures */
import { CursorStateService } from './cursor-state.service';
import type { CueTurn } from './types/cue-engine.types';

describe('CursorStateService', () => {
  let service: CursorStateService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };

    service = new CursorStateService(mockRedis);
  });

  describe('extractContentWords', () => {
    it('should remove stop words and apply stemming', () => {
      const words = CursorStateService.extractContentWords(
        'I would love to keep saying yes',
      );
      // "I", "would", "to" are stop words.
      // "yes" is intentionally NOT a stop word — it carries dialogue meaning.
      // "saying" stems to "say".
      expect(words).toEqual(['love', 'keep', 'say', 'yes']);
    });

    it('should handle punctuation', () => {
      const words = CursorStateService.extractContentWords(
        "Don't you think, Constantinople is beautiful?",
      );
      expect(words).toContain('constantinople');
      expect(words).toContain('beautiful');
      expect(words).not.toContain('you');
    });

    it('should return empty array for only stop words', () => {
      const words = CursorStateService.extractContentWords('I do it');
      expect(words).toEqual([]);
    });

    it('should return empty for empty input', () => {
      expect(CursorStateService.extractContentWords('')).toEqual([]);
    });
  });

  describe('isStopWord', () => {
    it('should identify stop words', () => {
      expect(CursorStateService.isStopWord('i')).toBe(true);
      expect(CursorStateService.isStopWord('the')).toBe(true);
      expect(CursorStateService.isStopWord('do')).toBe(true);
    });

    it('should not flag content words', () => {
      expect(CursorStateService.isStopWord('love')).toBe(false);
      expect(CursorStateService.isStopWord('constantinople')).toBe(false);
      expect(CursorStateService.isStopWord('beautiful')).toBe(false);
    });
  });

  describe('buildSceneIndex', () => {
    const turns: CueTurn[] = [
      {
        index: 0,
        type: 'actor',
        text: 'I would love to keep saying yes',
        lines: ['I would love to keep saying yes'],
        characterName: 'ACTOR',
      },
      {
        index: 1,
        type: 'hazel',
        text: 'No you cannot do that',
        lines: ['No you cannot do that'],
        characterName: 'HAZEL_CHAR',
      },
      {
        index: 2,
        type: 'actor',
        text: 'Constantinople is beautiful tonight',
        lines: ['Constantinople is beautiful tonight'],
        characterName: 'ACTOR',
      },
      {
        index: 3,
        type: 'action',
        text: 'He stands up slowly',
        lines: ['He stands up slowly'],
        pauseMs: 2000,
      },
      {
        index: 4,
        type: 'actor',
        text: 'Yes',
        lines: ['Yes'],
        characterName: 'ACTOR',
      },
    ];

    it('should only index actor turns', async () => {
      const state = await service.buildSceneIndex('reh-1', turns);

      expect(state.turnWordRanges[0]).toBeDefined();
      expect(state.turnWordRanges[1]).toBeUndefined(); // hazel
      expect(state.turnWordRanges[2]).toBeDefined();
      expect(state.turnWordRanges[3]).toBeUndefined(); // action
      expect(state.turnWordRanges[4]).toBeDefined();
    });

    it('should build contiguous content word array', async () => {
      const state = await service.buildSceneIndex('reh-1', turns);

      // turn 0: "love", "keep", "say" (stemmed from saying), "yes"
      //         ("I", "would", "to" are stop words; "yes" is NOT a stop word)
      // turn 2: "constantinople", "beautiful", "tonight" ("is" is a stop word)
      // turn 4: "yes" (1 content word)
      expect(state.sceneContentWords).toEqual([
        'love',
        'keep',
        'say',
        'yes',
        'constantinople',
        'beautiful',
        'tonight',
        'yes',
      ]);
    });

    it('should map turn word ranges correctly', async () => {
      const state = await service.buildSceneIndex('reh-1', turns);

      // turn 0: 4 content words → medium bucket, tailSize=min(2,4)=2
      expect(state.turnWordRanges[0]).toEqual({
        start: 0,
        end: 4,
        totalContentWords: 4,
        lineBucket: 'medium',
        tailStart: 2,
        tailEnd: 4,
      });
      // turn 2: 3 content words → short bucket, tailSize=1
      expect(state.turnWordRanges[2]).toEqual({
        start: 4,
        end: 7,
        totalContentWords: 3,
        lineBucket: 'short',
        tailStart: 6,
        tailEnd: 7,
      });
      // turn 4: 1 content word ("yes") → short bucket
      expect(state.turnWordRanges[4]).toEqual({
        start: 7,
        end: 8,
        totalContentWords: 1,
        lineBucket: 'short',
        tailStart: 7,
        tailEnd: 8,
      });
    });

    it('should persist to Redis', async () => {
      await service.buildSceneIndex('reh-1', turns);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'hazel:reh-1:cursor',
        expect.any(String),
        'EX',
        14400,
      );
    });

    it('should initialize cursor at position 0', async () => {
      const state = await service.buildSceneIndex('reh-1', turns);

      expect(state.cursorPosition).toBe(0);
      expect(state.currentTurnIndex).toBe(-1);
      expect(state.currentTurnMatchedCount).toBe(0);
    });
  });

  describe('getCursorState', () => {
    it('should return from cache if available', async () => {
      const turns: CueTurn[] = [
        {
          index: 0,
          type: 'actor',
          text: 'Hello world',
          lines: ['Hello world'],
        },
      ];
      await service.buildSceneIndex('reh-1', turns);

      const state = await service.getCursorState('reh-1');
      expect(state).not.toBeNull();
      // Redis.get should not have been called because cache hit
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should fall back to Redis if not cached', async () => {
      const mockState = {
        cursorPosition: 5,
        sceneContentWords: ['hello', 'world'],
        turnWordRanges: {},
        currentTurnMatchedCount: 0,
        currentTurnIndex: 0,
        committedContentWords: [],
        lastProcessedContentWords: [],
      };
      mockRedis.get.mockResolvedValue(JSON.stringify(mockState));

      const state = await service.getCursorState('reh-2');
      expect(state?.cursorPosition).toBe(5);
      expect(mockRedis.get).toHaveBeenCalledWith('hazel:reh-2:cursor');
    });

    it('should return null if not in cache or Redis', async () => {
      const state = await service.getCursorState('nonexistent');
      expect(state).toBeNull();
    });
  });

  describe('resetCursorForTurn', () => {
    it('should reposition cursor to turn start', async () => {
      const turns: CueTurn[] = [
        {
          index: 0,
          type: 'actor',
          text: 'I love freedom',
          lines: ['I love freedom'],
        },
        { index: 1, type: 'hazel', text: 'Me too', lines: ['Me too'] },
        {
          index: 2,
          type: 'actor',
          text: 'Constantinople awaits',
          lines: ['Constantinople awaits'],
        },
      ];
      const state = await service.buildSceneIndex('reh-1', turns);
      state.cursorPosition = 5; // somewhere in the middle
      state.currentTurnMatchedCount = 2;
      service.updateInMemory('reh-1', state);

      await service.resetCursorForTurn('reh-1', 2);

      const updated = await service.getCursorState('reh-1');
      // turn 2 starts after "love", "freedom" (2 words from turn 0)
      expect(updated?.cursorPosition).toBe(2);
      expect(updated?.currentTurnMatchedCount).toBe(0);
      expect(updated?.currentTurnIndex).toBe(2);
    });
  });

  describe('resetForNewTurn', () => {
    it('should reset matched count without moving cursor', async () => {
      const turns: CueTurn[] = [
        {
          index: 0,
          type: 'actor',
          text: 'I love freedom',
          lines: ['I love freedom'],
        },
        {
          index: 1,
          type: 'actor',
          text: 'Constantinople awaits',
          lines: ['Constantinople awaits'],
        },
      ];
      const state = await service.buildSceneIndex('reh-1', turns);
      state.cursorPosition = 2;
      state.currentTurnMatchedCount = 2;
      service.updateInMemory('reh-1', state);

      await service.resetForNewTurn('reh-1', 1);

      const updated = await service.getCursorState('reh-1');
      expect(updated?.cursorPosition).toBe(2); // unchanged
      expect(updated?.currentTurnMatchedCount).toBe(0); // reset
      expect(updated?.currentTurnIndex).toBe(1);
    });

    it('should NOT set pendingRewindBaseline on forward progression', async () => {
      const turns: CueTurn[] = [
        {
          index: 0,
          type: 'actor',
          text: 'I love freedom',
          lines: ['I love freedom'],
        },
        {
          index: 1,
          type: 'actor',
          text: 'Constantinople awaits',
          lines: ['Constantinople awaits'],
        },
      ];
      await service.buildSceneIndex('reh-1', turns);

      await service.resetForNewTurn('reh-1', 1);

      const updated = await service.getCursorState('reh-1');
      expect(updated?.pendingRewindBaseline).toBeFalsy();
    });

    it('should preserve pendingRewindBaseline if already set by a prior rewind', async () => {
      // simulates: user rewinds (resetCursorForTurn sets baseline=true),
      // then the turn sequencer dispatches the turn (resetForNewTurn runs).
      // The baseline flag must survive that re-dispatch so the first
      // post-rewind transcript is still swallowed.
      const turns: CueTurn[] = [
        {
          index: 0,
          type: 'actor',
          text: 'I love freedom',
          lines: ['I love freedom'],
        },
        {
          index: 1,
          type: 'actor',
          text: 'Constantinople awaits',
          lines: ['Constantinople awaits'],
        },
      ];
      await service.buildSceneIndex('reh-1', turns);
      await service.resetCursorForTurn('reh-1', 1); // arms baseline
      expect(
        (await service.getCursorState('reh-1'))?.pendingRewindBaseline,
      ).toBe(true);

      await service.resetForNewTurn('reh-1', 1);

      const updated = await service.getCursorState('reh-1');
      expect(updated?.pendingRewindBaseline).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove from cache', async () => {
      const turns: CueTurn[] = [
        {
          index: 0,
          type: 'actor',
          text: 'Hello world',
          lines: ['Hello world'],
        },
      ];
      await service.buildSceneIndex('reh-1', turns);

      service.cleanup('reh-1');

      // Should now return null from cache, hit Redis
      mockRedis.get.mockResolvedValue(null);
      const state = await service.getCursorState('reh-1');
      expect(state).toBeNull();
    });
  });
});
