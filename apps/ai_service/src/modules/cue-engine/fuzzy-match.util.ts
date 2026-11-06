// fuzzy word matching utilities for cue detection.
// lightweight Levenshtein distance + Porter-style stemmer.
// no external dependencies — keeps the bundle lean.

/**
 * Compute the Levenshtein edit distance between two strings.
 * O(m*n) time and O(min(m,n)) space (single-row DP).
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // ensure a is the shorter string for O(min(m,n)) space
  if (a.length > b.length) [a, b] = [b, a];

  const aLen = a.length;
  const bLen = b.length;
  const row = new Uint16Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) row[i] = i;

  for (let j = 1; j <= bLen; j++) {
    let prev = row[0];
    row[0] = j;

    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const current = row[i];
      row[i] = Math.min(
        row[i] + 1, // deletion
        row[i - 1] + 1, // insertion
        prev + cost, // substitution
      );
      prev = current;
    }
  }

  return row[aLen];
}

/**
 * Check if two words are a fuzzy match.
 *
 * Rules:
 *   - exact match → true
 *   - length difference > 3 → false (fast reject)
 *   - words ≤ 3 chars → must be exact (too short for fuzzy)
 *   - words 4-5 chars → edit distance ≤ 1
 *   - words 6+ chars → edit distance ≤ 2
 */
export function isFuzzyWordMatch(a: string, b: string): boolean {
  if (a === b) return true;

  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);

  // fast reject on length difference
  if (maxLen - minLen > 3) return false;

  // very short words must match exactly
  if (minLen <= 3) return false;

  const maxDistance = minLen <= 5 ? 1 : 2;
  return levenshteinDistance(a, b) <= maxDistance;
}

/**
 * Lightweight English stemmer for speech-to-script matching.
 *
 * Not a full Porter stemmer — intentionally simplified to handle
 * the most common inflections that cause Deepgram mismatches:
 *   - "cooking" → "cook", "cookin" → "cook"
 *   - "going" → "go", "goin" → "go"
 *   - "talked" → "talk", "walks" → "walk"
 *   - "happily" → "happi" (adverb)
 *   - "guys" → "guy", "tries" → "tri"
 *
 * Stems are NOT meant to be real English words — they just need
 * to be consistent between expected and spoken forms.
 */
export function stemWord(word: string): string {
  if (word.length <= 3) return word;

  let w = word;

  // Step 1: Remove common contractions residue
  // "whats" → "what", "dont" → "dont" (already fine), "youre" → "your"
  if (w.endsWith('s') && w.length > 4) {
    if (w.endsWith('ies') && w.length > 4) {
      // "tries" → "tri", "guys" stays because doesn't end in ies
      w = w.slice(0, -3) + 'i';
    } else if (w.endsWith('sses')) {
      w = w.slice(0, -2);
    } else if (w.endsWith('ss') || w.endsWith('us')) {
      // "pass" → "pass", "bonus" → "bonus" (keep)
    } else {
      // "whats" → "what", "walks" → "walk"
      w = w.slice(0, -1);
    }
  }

  // Step 2: -ing and -in (Deepgram often drops the g)
  if (w.endsWith('ing') && w.length > 5) {
    const base = w.slice(0, -3);
    // "cooking" → "cook", "going" → "go"
    // "running" → "runn" → needs double-consonant fix
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      w = base.slice(0, -1); // "running" → "run"
    } else {
      w = base;
    }
  } else if (w.endsWith('in') && w.length > 4) {
    // "cookin" → "cook", "goin" → "go"
    const base = w.slice(0, -2);
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      w = base.slice(0, -1);
    } else {
      w = base;
    }
  }

  // Step 3: -ed
  if (w.endsWith('ed') && w.length > 4) {
    const base = w.slice(0, -2);
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      w = base.slice(0, -1); // "stopped" → "stop"
    } else {
      w = base;
    }
  }

  // Step 4: -ly (adverbs)
  if (w.endsWith('ly') && w.length > 5) {
    w = w.slice(0, -2);
  }

  // Step 5: -er
  if (w.endsWith('er') && w.length > 5) {
    const base = w.slice(0, -2);
    if (base.length >= 2 && base[base.length - 1] === base[base.length - 2]) {
      w = base.slice(0, -1);
    } else {
      w = base;
    }
  }

  return w;
}

/**
 * Compare two words using stemming + fuzzy matching.
 * Returns true if they're considered equivalent for cue detection.
 *
 * Matching order:
 *   1. Exact match (cheapest)
 *   2. Stem match (both stem to the same root)
 *   3. Fuzzy match on raw words (handles transcription typos)
 *   4. Fuzzy match on stemmed words (handles both inflection + typo)
 */
export function isWordMatch(a: string, b: string): boolean {
  if (a === b) return true;

  const stemA = stemWord(a);
  const stemB = stemWord(b);

  if (stemA === stemB) return true;
  if (isFuzzyWordMatch(a, b)) return true;
  if (stemA !== a && stemB !== b && isFuzzyWordMatch(stemA, stemB)) return true;

  return false;
}
