import { contentWordOverlap } from './word-overlap.util';

describe('contentWordOverlap', () => {
  const line =
    "You girls are so fucking sweet like truly hearts of gold-- but I'm good.";

  it('returns high overlap for a loose paraphrase', () => {
    const spoken =
      'you girl are so fucking sweet like truly are so silver but im bomb you girl are so fucking sweet like truly are so good';
    expect(contentWordOverlap(spoken, line)).toBeGreaterThan(0.5);
  });

  it('returns near-zero for a completely unrelated utterance', () => {
    const spoken = 'can I get a cheeseburger and fries please';
    expect(contentWordOverlap(spoken, line)).toBeLessThan(0.15);
  });

  it('returns 0 for empty transcript', () => {
    expect(contentWordOverlap('', line)).toBe(0);
  });

  it('returns 0 when expected line has no words', () => {
    expect(contentWordOverlap('anything', '')).toBe(0);
  });
});
