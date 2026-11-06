import { buildSequenceSnapshot } from './rehearsal-sequence-snapshot.interface';

describe('buildSequenceSnapshot', () => {
  it('maps Hazel turns (type) to snapshot entries', () => {
    const { entries, meta } = buildSequenceSnapshot(
      [
        {
          index: 0,
          type: 'actor',
          characterId: 'c1',
          characterName: 'MARA',
          text: '  Hello  ',
        },
        { index: 1, type: 'hazel', characterName: 'JOHN', text: 'Hi' },
      ],
      'hazel',
    );

    expect(entries).toEqual([
      {
        index: 0,
        type: 'actor',
        characterId: 'c1',
        characterName: 'MARA',
        text: 'Hello',
      },
      {
        index: 1,
        type: 'hazel',
        characterId: null,
        characterName: 'JOHN',
        text: 'Hi',
      },
    ]);
    expect(meta.engine).toBe('hazel');
    expect(meta.turnCount).toBe(2);
    expect(meta.includeActions).toBeUndefined();
  });

  it('maps Teleprompter turns (kind) and records includeActions', () => {
    const { entries, meta } = buildSequenceSnapshot(
      [{ index: 0, kind: 'line', text: 'A line' }],
      'teleprompter',
      { includeActions: false },
    );

    expect(entries[0].type).toBe('line');
    expect(meta.engine).toBe('teleprompter');
    expect(meta.includeActions).toBe(false);
  });

  it('uses null (never "") for empty/whitespace text and missing identity', () => {
    const { entries } = buildSequenceSnapshot(
      [{ index: 0, kind: 'action', text: '   ' }],
      'teleprompter',
    );
    expect(entries[0].text).toBeNull();
    expect(entries[0].characterId).toBeNull();
    expect(entries[0].characterName).toBeNull();
  });
});
