import {
  MAX_EVENT_TEXT_LENGTH,
  buildTurnEventData,
  normalizeEventText,
} from './rehearsal-event-data.interface';

describe('normalizeEventText', () => {
  it('returns null for non-strings, empty, and whitespace-only', () => {
    expect(normalizeEventText(undefined)).toBeNull();
    expect(normalizeEventText(null)).toBeNull();
    expect(normalizeEventText('')).toBeNull();
    expect(normalizeEventText('   ')).toBeNull();
  });

  it('trims and never returns an empty string', () => {
    expect(normalizeEventText('  hello  ')).toBe('hello');
  });

  it('truncates to MAX_EVENT_TEXT_LENGTH', () => {
    const long = 'a'.repeat(MAX_EVENT_TEXT_LENGTH + 50);
    expect(normalizeEventText(long)).toHaveLength(MAX_EVENT_TEXT_LENGTH);
  });
});

describe('buildTurnEventData (producer/consumer contract)', () => {
  const turn = {
    index: 8,
    characterId: 'char-1',
    characterName: 'MARA',
    text: 'I need a little badge',
  };

  it('denormalizes line identity from the turn onto the event data', () => {
    const data = buildTurnEventData(turn, { transcript: 'no match' });
    // The exact keys the analytics aggregator reads.
    expect(data.lineIndex).toBe(8);
    expect(data.characterId).toBe('char-1');
    expect(data.characterName).toBe('MARA');
    expect(data.text).toBe('I need a little badge');
    // Extra diagnostics are preserved.
    expect(data.transcript).toBe('no match');
  });

  it('uses null (never "") for unknown identity when turn is null', () => {
    const data = buildTurnEventData(null, { lineIndex: 3 });
    expect(data.lineIndex).toBe(3);
    expect(data.characterId).toBeNull();
    expect(data.characterName).toBeNull();
    expect(data.text).toBeNull();
  });

  it('falls back to extra.lineIndex when the turn is null', () => {
    expect(buildTurnEventData(undefined, { lineIndex: 5 }).lineIndex).toBe(5);
  });

  it('prefers turn identity over extra', () => {
    const data = buildTurnEventData(turn, {
      characterId: 'stale',
      lineIndex: 99,
    });
    expect(data.characterId).toBe('char-1');
    expect(data.lineIndex).toBe(8);
  });

  it('truncates the persisted text', () => {
    const data = buildTurnEventData({
      index: 0,
      text: 'x'.repeat(MAX_EVENT_TEXT_LENGTH + 10),
    });
    expect(data.text).toHaveLength(MAX_EVENT_TEXT_LENGTH);
  });
});
