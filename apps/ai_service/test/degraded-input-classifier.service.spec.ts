import {
  classifyDegradedInput,
  type DegradedInputSignalBundle,
} from '../src/modules/ai-orchestrator/services/degraded-input-classifier.service';

function makeBundle(
  overrides: Partial<DegradedInputSignalBundle> = {},
): DegradedInputSignalBundle {
  return {
    pageCount: 2,
    parsedPageCount: 2,
    pageCoverageRatio: 1,
    sceneCount: 2,
    sceneHeadings: ['INT. OFFICE - DAY', 'EXT. STREET - NIGHT'],
    structureConfidenceScore: 0.9,
    lowConfidenceFlag: false,
    watermarkDetected: false,
    structuralWarnings: [],
    structuralClassificationWarnings: [],
    qualityGatePassed: true,
    qualityGateReasons: [],
    fallbackUsed: false,
    characterLineCounts: [
      { name: 'TINA', lineCount: 20 },
      { name: 'CARMEN', lineCount: 10 },
    ],
    analysisCharacterNames: ['TINA', 'CARMEN'],
    ...overrides,
  };
}

describe('degraded input classifier', () => {
  it('classifies a healthy clean short side as supported', () => {
    const result = classifyDegradedInput(makeBundle());

    expect(result.decision).toBe('supported');
    expect(result.fileClass).toBe('clean_short_side');
    expect(result.failureCode).toBeNull();
    expect(result.reasons).toEqual([]);
  });

  it('rejects collapsed page recovery and generic document structure', () => {
    const result = classifyDegradedInput(
      makeBundle({
        pageCount: 1,
        parsedPageCount: 0,
        pageCoverageRatio: 0,
        sceneCount: 1,
        sceneHeadings: ['(Document)'],
        structureConfidenceScore: 0.52,
        // Truly degraded: no real characters recovered
        characterLineCounts: [{ name: '- -', lineCount: 1 }],
        analysisCharacterNames: [],
      }),
    );

    expect(result.decision).toBe('unsupported_degraded');
    expect(result.failureCode).toBe('VISUALLY_DEGRADED_INPUT');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'Page coverage ratio is too low for reliable analysis (0).',
        'Parser did not recover any usable pages.',
        'Recovered structure collapsed into a generic document block.',
      ]),
    );
  });

  it('allows pasted text with dialogue structure but no scene headings', () => {
    const result = classifyDegradedInput(
      makeBundle({
        pageCount: 3,
        parsedPageCount: 3,
        pageCoverageRatio: 1,
        sceneCount: 1,
        sceneHeadings: ['(Document)'],
        characterLineCounts: [
          { name: 'KAFFEE', lineCount: 20 },
          { name: 'JO', lineCount: 15 },
        ],
        analysisCharacterNames: ['KAFFEE', 'JO'],
      }),
    );

    expect(result.decision).not.toBe('unsupported_degraded');
    expect(result.failureCode).toBeNull();
    expect(result.reasons).toEqual([]);
  });

  it('rejects gibberish-dominated character extraction', () => {
    const result = classifyDegradedInput(
      makeBundle({
        structureConfidenceScore: 0.4,
        characterLineCounts: [
          { name: '6 6', lineCount: 20 },
          { name: '- -', lineCount: 18 },
          { name: ': :', lineCount: 16 },
          { name: '9 9', lineCount: 14 },
          { name: '0 - 0', lineCount: 12 },
          { name: 'T', lineCount: 1 },
        ],
        analysisCharacterNames: ['LILY', 'MARK'],
      }),
    );

    expect(result.decision).toBe('unsupported_degraded');
    expect(result.fileClass).toBe('ocr_corrupted_pdf');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'Structure confidence is low and extracted character cues are dominated by gibberish.',
        'Extracted character cues are dominated by implausible names.',
      ]),
    );
  });

  it('classifies watermark-only noise as degraded but allowed when structure is still strong', () => {
    const result = classifyDegradedInput(
      makeBundle({
        watermarkDetected: true,
        structuralWarnings: [
          'Removed 4 lines suspected to be watermarks or tracking codes.',
        ],
      }),
    );

    expect(result.decision).toBe('degraded_but_allowed');
    expect(result.fileClass).toBe('moderate_noise');
    expect(result.failureCode).toBeNull();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Watermark detected, but structure remained strong enough to continue.',
        'Removed 4 lines suspected to be watermarks or tracking codes.',
      ]),
    );
  });
});
