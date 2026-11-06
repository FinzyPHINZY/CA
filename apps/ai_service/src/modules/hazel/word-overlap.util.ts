// Loose content-word overlap for the advisory wrong-line guard.
// Deliberately dumb: lowercase, strip punctuation, split on whitespace,
// set-overlap of expected words covered by spoken words. No stemming, no
// fuzzy matching — this only needs to separate "roughly the line" from
// "completely different speech".

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'i',
  'you',
  'so',
  'it',
  'im',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

/**
 * Fraction of the expected line's content words that appear in the spoken
 * transcript. Range [0, 1]. Returns 0 when either side has no content words.
 */
export function contentWordOverlap(spoken: string, expected: string): number {
  const expectedWords = tokenize(expected);
  if (expectedWords.length === 0) return 0;

  const spokenSet = new Set(tokenize(spoken));
  if (spokenSet.size === 0) return 0;

  const covered = expectedWords.filter((w) => spokenSet.has(w)).length;
  return covered / expectedWords.length;
}

/** Number of content words (stop words removed) in a piece of text. */
export function contentWordCount(text: string): number {
  return tokenize(text).length;
}
