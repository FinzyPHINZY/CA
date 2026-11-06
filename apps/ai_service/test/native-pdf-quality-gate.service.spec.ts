import { NativePdfQualityGateService } from '../src/modules/ai-orchestrator/services/extraction/native-pdf-quality-gate.service';

describe('native pdf quality gate service', () => {
  let service: NativePdfQualityGateService;

  beforeEach(() => {
    service = new NativePdfQualityGateService();
  });

  it('accepts a healthy structured native extraction result', () => {
    const decision = service.evaluate(
      {
        coverageRatio: 1,
        pagesParsedRatio: 1,
        parsedPages: [1, 2],
        warnings: [],
        structuralFlags: {},
        fdxResult: {
          title: null,
          rawText: 'INT. KITCHEN - DAY',
          characters: ['SARAH', 'MARCUS'],
          scenes: [
            {
              number: 1,
              heading: 'INT. KITCHEN - DAY',
              page: 1,
              pages: [1],
              characters: ['SARAH', 'MARCUS'],
              elements: [
                { type: 'dialogue', lines: ['Hello'], page: 1 },
              ] as any,
            },
          ],
        },
      },
      { pageCount: 2 },
    );

    expect(decision.accepted).toBe(true);
    expect(decision.reasons).toEqual([]);
  });

  it('rejects a short-document native result that misses the first page and dialogue structure', () => {
    const decision = service.evaluate(
      {
        coverageRatio: 0.5,
        pagesParsedRatio: 0.5,
        parsedPages: [2],
        warnings: [
          'No dialogue blocks detected. Script may be action-only or extraction failed to detect characters.',
        ],
        structuralFlags: {},
        fdxResult: {
          title: null,
          rawText: 'SCENE 1',
          characters: ['TINA'],
          scenes: [
            {
              number: 1,
              heading: 'SCENE 1',
              page: 2,
              pages: [2],
              characters: ['TINA'],
              elements: [{ type: 'action', lines: ['Noise'], page: 2 }] as any,
            },
          ],
        },
      },
      { pageCount: 2 },
    );

    expect(decision.accepted).toBe(false);
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'Native PDF extraction coverage was too low (0.50).',
        'Native PDF extraction recovered neither explicit scene headings nor dialogue blocks.',
        'Native PDF extraction missed the first content page on a short document (first parsed page 2).',
        'Native PDF extraction did not recover enough dialogue structure for a short side or packet.',
      ]),
    );
  });
});
