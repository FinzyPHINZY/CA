/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures */
import { DeepgramService } from './deepgram.service';
import type { CueTurn } from './types/cue-engine.types';

describe('DeepgramService.buildKeywordWindow', () => {
  let service: DeepgramService;

  beforeEach(() => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('stub'),
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    } as any;
    service = new DeepgramService(config);
  });

  function turn(index: number, type: CueTurn['type'], text: string): CueTurn {
    return { index, type, text, lines: [text] };
  }

  it('returns empty for empty sequence or out-of-range index', () => {
    expect(service.buildKeywordWindow([], 0)).toEqual([]);
    expect(
      service.buildKeywordWindow([turn(0, 'actor', 'hello world')], -1),
    ).toEqual([]);
    expect(
      service.buildKeywordWindow([turn(0, 'actor', 'hello world')], 5),
    ).toEqual([]);
  });

  it('includes the current actor turn plus next two actor turns', () => {
    const seq: CueTurn[] = [
      turn(0, 'actor', 'followed that fish upriver'),
      turn(1, 'hazel', 'How interesting'),
      turn(2, 'actor', 'three days and three nights'),
      turn(3, 'action', '(she sighs)'),
      turn(4, 'actor', 'until I cornered him completely'),
      turn(5, 'actor', 'and never let go'),
    ];

    const result = service.buildKeywordWindow(seq, 0, 2);

    // current actor turn (0) + next 2 actor turns (2, 4)
    expect(result.some((kw) => kw.startsWith('followed'))).toBe(true);
    expect(result.some((kw) => kw.startsWith('upriver'))).toBe(true);
    expect(result.some((kw) => kw.startsWith('nights'))).toBe(true);
    expect(result.some((kw) => kw.startsWith('cornered'))).toBe(true);
    // 4th actor turn (5) should NOT be included
    expect(result.some((kw) => kw.includes('never'))).toBe(false);
  });

  it('skips hazel and action turns when starting from a non-actor turn', () => {
    const seq: CueTurn[] = [
      turn(0, 'hazel', 'I see'),
      turn(1, 'action', 'pause'),
      turn(2, 'actor', 'cornered him completely'),
    ];

    const result = service.buildKeywordWindow(seq, 0, 2);

    expect(result.some((kw) => kw.startsWith('cornered'))).toBe(true);
    expect(result.some((kw) => kw.startsWith('completely'))).toBe(true);
    // hazel words should not appear
    expect(result.some((kw) => kw.includes('see'))).toBe(false);
  });

  it('strips stop words but keeps short proper nouns', () => {
    const seq: CueTurn[] = [turn(0, 'actor', 'I am at the house Per')];
    const result = service.buildKeywordWindow(seq, 0);

    // "I", "am", "at", "the" are stop words.
    // "house" and "per" survive — "per" is 3 chars but must NOT be dropped,
    // short proper nouns are exactly what Deepgram most needs boosted.
    // Current turn boost is 3.0.
    expect(result).toEqual(['house:3', 'per:3']);
  });

  it('boosts current turn higher than lookahead turns', () => {
    const seq: CueTurn[] = [
      turn(0, 'actor', 'cornered'),
      turn(1, 'actor', 'upriver'),
    ];
    const result = service.buildKeywordWindow(seq, 0, 1);

    // current turn word gets 3.0, lookahead word gets 1.5
    expect(result).toContain('cornered:3');
    expect(result).toContain('upriver:1.5');
  });

  it('deduplicates words across turns', () => {
    const seq: CueTurn[] = [
      turn(0, 'actor', 'house keeper found house'),
      turn(1, 'actor', 'house empty house gone'),
    ];
    const result = service.buildKeywordWindow(seq, 0);
    const houseEntries = result.filter((kw) => kw.startsWith('house'));
    expect(houseEntries.length).toBe(1);
  });

  it('formats output as word:boost pairs', () => {
    const seq: CueTurn[] = [turn(0, 'actor', 'cornered upriver')];
    const result = service.buildKeywordWindow(seq, 0);
    for (const kw of result) {
      expect(kw).toMatch(/^[a-z]+:\d+(\.\d+)?$/);
    }
  });

  describe('shouldReconnectForKeywordChange', () => {
    it('reconnects when previous is empty or null', () => {
      expect(service.shouldReconnectForKeywordChange(null, ['house:3'])).toBe(
        true,
      );
      expect(service.shouldReconnectForKeywordChange([], ['house:3'])).toBe(
        true,
      );
    });

    it('does not reconnect when next is empty (nothing to apply)', () => {
      expect(service.shouldReconnectForKeywordChange(['house:3'], [])).toBe(
        false,
      );
    });

    it('does not reconnect when sets are identical', () => {
      const kws = ['house:3', 'river:3', 'dog:1.5'];
      expect(service.shouldReconnectForKeywordChange(kws, kws)).toBe(false);
    });

    it('does not reconnect when only boost values differ (same words)', () => {
      expect(
        service.shouldReconnectForKeywordChange(
          ['house:3', 'river:1.5'],
          ['house:1.5', 'river:3'],
        ),
      ).toBe(false);
    });

    it('does not reconnect when overlap is above threshold (default 0.7)', () => {
      // 4 shared, 1 unique on each side → intersection=4, union=6 → 0.67
      // that's BELOW 0.7, so it SHOULD reconnect. Adjust to hit ≥0.7:
      // 7 shared, 1 unique each → intersection=7, union=9 → 0.778
      const prev = ['a:3', 'b:3', 'c:3', 'd:3', 'e:3', 'f:3', 'g:3', 'h:3'];
      const next = ['a:3', 'b:3', 'c:3', 'd:3', 'e:3', 'f:3', 'g:3', 'z:3'];
      expect(service.shouldReconnectForKeywordChange(prev, next)).toBe(false);
    });

    it('reconnects when the keyword sets are mostly different', () => {
      // 1 shared, 3 unique each → intersection=1, union=7 → 0.14
      expect(
        service.shouldReconnectForKeywordChange(
          ['house:3', 'river:3', 'dog:3', 'cat:3'],
          ['house:3', 'tree:3', 'bird:3', 'cloud:3'],
        ),
      ).toBe(true);
    });

    it('respects a custom threshold', () => {
      // 3 shared, 1 unique each → intersection=3, union=5 → 0.6
      const prev = ['a:3', 'b:3', 'c:3', 'd:3'];
      const next = ['a:3', 'b:3', 'c:3', 'z:3'];
      expect(service.shouldReconnectForKeywordChange(prev, next, 0.5)).toBe(
        false,
      );
      expect(service.shouldReconnectForKeywordChange(prev, next, 0.7)).toBe(
        true,
      );
    });
  });

  it('caps output at 50 keywords', () => {
    const manyWords = Array.from(
      { length: 200 },
      (_, i) => `wordnumber${i}`,
    ).join(' ');
    const seq: CueTurn[] = [turn(0, 'actor', manyWords)];
    const result = service.buildKeywordWindow(seq, 0);
    expect(result.length).toBe(50);
  });
});

describe('DeepgramService.getRecommendedConfig — model-driven term boosting', () => {
  function build(model: string): DeepgramService {
    const config = {
      getOrThrow: jest.fn().mockReturnValue('stub'),
      get: jest.fn((key: string, fallback: unknown) => {
        if (key === 'DEEPGRAM_MODEL') return model;
        return fallback;
      }),
    } as any;
    return new DeepgramService(config);
  }

  it('uses the keywords param on nova-2', () => {
    const svc = build('nova-2');
    const config = svc.getRecommendedConfig(['hello:2.5', 'world:1.5']);
    expect(config.model).toBe('nova-2');
    expect(config.keywords).toEqual(['hello:2.5', 'world:1.5']);
    expect(config.keyterm).toBeUndefined();
  });

  it('switches to the keyterm param on nova-3 and strips boost suffixes', () => {
    const svc = build('nova-3');
    const config = svc.getRecommendedConfig(['hello:2.5', 'world:1.5']);
    expect(config.model).toBe('nova-3');
    expect(config.keyterm).toEqual(['hello', 'world']);
    expect(config.keywords).toBeUndefined();
  });

  it('exposes usesKeyterm based on the configured model', () => {
    expect(build('nova-2').usesKeyterm).toBe(false);
    expect(build('nova-3').usesKeyterm).toBe(true);
    expect(build('nova-3-en').usesKeyterm).toBe(true);
  });

  it('emits no term-boost params when no keywords are passed', () => {
    const svc = build('nova-3');
    const config = svc.getRecommendedConfig();
    expect(config.keyterm).toBeUndefined();
    expect(config.keywords).toBeUndefined();
  });
});
