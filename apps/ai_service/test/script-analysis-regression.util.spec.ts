import {
  evaluateRegressionSuite,
  extractRegressionMetrics,
  type ScriptAnalysisRegressionManifest,
} from './support/script-analysis-regression';

describe('script analysis regression evaluator', () => {
  it('passes a healthy parser-first snapshot against quality expectations', () => {
    const manifest: ScriptAnalysisRegressionManifest = {
      version: 1,
      suiteName: 'script-analysis-regression',
      cases: [
        {
          id: 'clean-feature',
          description: 'Clean parser-first script result',
          category: 'clean_pdf',
          snapshotPath: 'fixtures/clean-feature.json',
          expectations: {
            allowedStatuses: ['ANALYZED'],
            requireAttentionRequired: false,
            forbidFallback: true,
            minPageCoverageRatio: 0.98,
            minSceneCoverageRatio: 0.95,
            minSemanticUnitCoverageRatio: 0.95,
            minSceneCount: 2,
            minCharacterCount: 2,
            requireStructuralPath: 'python_script_parser',
            requireSemanticPath: 'gemini_scene_semantic',
            requiredCharacters: ['JOHN', 'MAYA'],
            requiredSceneHeadings: ['INT. OFFICE - DAY'],
          },
        },
      ],
    };

    const suiteResult = evaluateRegressionSuite(manifest, {
      baseDir: '/tmp',
      loadSnapshot: () => ({
        status: 'ANALYZED',
        analysisLifecycle: {
          attentionRequired: false,
          degraded: false,
          fallbackUsed: false,
          structuralPath: 'python_script_parser',
          semanticPath: 'gemini_scene_semantic',
          sceneCoverageRatio: 1,
          semanticUnitCoverageRatio: 1,
          structuralWarnings: [],
          semanticWarnings: [],
        },
        parserMetadata: {
          coverageRatio: 1,
        },
        characters: [{ name: 'JOHN' }, { name: 'MAYA' }],
        scenes: [
          { heading: 'INT. OFFICE - DAY' },
          { heading: 'EXT. STREET - NIGHT' },
        ],
      }),
    });

    expect(suiteResult.failedCases).toBe(0);
    expect(suiteResult.passedCases).toBe(1);
    expect(suiteResult.caseResults[0].reasons).toEqual([]);
  });

  it('reports missing characters, fallback usage, and low coverage as failures', () => {
    const manifest: ScriptAnalysisRegressionManifest = {
      version: 1,
      suiteName: 'script-analysis-regression',
      cases: [
        {
          id: 'watermark-side',
          description: 'Watermark-heavy side should not degrade silently',
          category: 'watermark_pdf',
          snapshotPath: 'fixtures/watermark-side.json',
          expectations: {
            allowedStatuses: ['ANALYZED'],
            requireAttentionRequired: false,
            forbidFallback: true,
            minPageCoverageRatio: 0.9,
            minSceneCoverageRatio: 0.9,
            minSemanticUnitCoverageRatio: 0.9,
            requiredCharacters: ['ELLA'],
          },
        },
      ],
    };

    const suiteResult = evaluateRegressionSuite(manifest, {
      baseDir: '/tmp',
      loadSnapshot: () => ({
        status: 'ANALYZED',
        parserMetadata: {
          coverageRatio: 0.72,
          semanticAnalysis: {
            sceneCoverageRatio: 0.6,
            semanticUnitCoverageRatio: 0.5,
          },
        },
        analysisLifecycle: {
          attentionRequired: true,
          degraded: true,
          fallbackUsed: true,
          structuralPath: 'python_script_parser',
          semanticPath: 'gemini_scene_semantic_with_raw_text_fallback',
        },
        characters: [{ name: 'TOM' }],
        scenes: [{ heading: 'INT. STUDIO - DAY' }],
      }),
    });

    expect(suiteResult.failedCases).toBe(1);
    expect(suiteResult.caseResults[0].reasons).toEqual(
      expect.arrayContaining([
        'Expected attentionRequired=false but received true',
        'Fallback was used but manifest forbids it',
        'Expected pageCoverageRatio >= 0.9 but received 0.72',
        'Expected sceneCoverageRatio >= 0.9 but received 0.6',
        'Expected semanticUnitCoverageRatio >= 0.9 but received 0.5',
        'Missing required character ELLA',
      ]),
    );
  });

  it('extracts lifecycle and parser metadata from nested API payloads', () => {
    const metrics = extractRegressionMetrics({
      script: {
        status: 'FAILED',
        parserMetadata: {
          coverageRatio: 0.4,
          analysisPath: {
            structuralPath: 'python_script_parser',
            semanticPath: 'parser_failed_before_semantic',
          },
          analysisLifecycle: {
            attentionRequired: true,
            failureStage: 'parser_validation',
            failureCode: 'NOT_A_SCREENPLAY',
          },
          structuralWarnings: ['Low confidence parse'],
        },
      },
    });

    expect(metrics.status).toBe('FAILED');
    expect(metrics.pageCoverageRatio).toBe(0.4);
    expect(metrics.structuralPath).toBe('python_script_parser');
    expect(metrics.semanticPath).toBe('parser_failed_before_semantic');
    expect(metrics.failureStage).toBe('parser_validation');
    expect(metrics.failureCode).toBe('NOT_A_SCREENPLAY');
    expect(metrics.structuralWarnings).toEqual(['Low confidence parse']);
  });

  it('passes an intentional degraded-file rejection when the manifest expects failure', () => {
    const manifest: ScriptAnalysisRegressionManifest = {
      version: 1,
      suiteName: 'script-analysis-regression',
      cases: [
        {
          id: 'marked-up-side',
          description:
            'Unsupported degraded marked-up side should reject cleanly',
          category: 'marked_up_pdf',
          snapshotPath: 'fixtures/marked-up-side.json',
          expectations: {
            allowedStatuses: ['FAILED'],
            requireAttentionRequired: true,
            requireDegraded: false,
            forbidFallback: true,
            requireFailureStage: 'degraded_input_screening',
            requireFailureCode: 'VISUALLY_DEGRADED_INPUT',
            requireClassificationDecision: 'unsupported_degraded',
            requireStructuralPath: 'python_script_parser',
          },
        },
      ],
    };

    const suiteResult = evaluateRegressionSuite(manifest, {
      baseDir: '/tmp',
      loadSnapshot: () => ({
        status: 'FAILED',
        parserMetadata: {
          degradedInputClassification: {
            decision: 'unsupported_degraded',
            fileClass: 'marked_up_pdf',
          },
          analysisPath: {
            structuralPath: 'python_script_parser',
            semanticPath: 'gemini_scene_semantic',
          },
          analysisLifecycle: {
            attentionRequired: true,
            degraded: false,
            fallbackUsed: false,
            failureStage: 'degraded_input_screening',
            failureCode: 'VISUALLY_DEGRADED_INPUT',
          },
        },
      }),
    });

    expect(suiteResult.failedCases).toBe(0);
    expect(suiteResult.passedCases).toBe(1);
    expect(suiteResult.caseResults[0].reasons).toEqual([]);
  });
});
