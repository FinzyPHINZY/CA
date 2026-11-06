import { ScriptStatus } from '@app/common';
import { buildScriptAnalysisLifecycleSummary } from './script-analysis-lifecycle.util';

describe('buildScriptAnalysisLifecycleSummary', () => {
  it('marks degraded analyzed scripts as completed_with_attention', () => {
    const summary = buildScriptAnalysisLifecycleSummary({
      status: ScriptStatus.ANALYZED,
      parserMetadata: {
        analysisPath: {
          structuralPath: 'python_script_parser',
          semanticPath: 'gemini_scene_semantic_with_raw_text_fallback',
        },
        semanticAnalysis: {
          semanticStrategy: 'scene_based',
          sceneCoverageRatio: 0.83,
          semanticUnitCoverageRatio: 0.78,
          synthesisFallbackUsed: true,
          qualityGate: {
            passed: false,
            reasons: ['Semantic unit coverage below threshold'],
          },
        },
      } as any,
    } as any);

    expect(summary).toEqual({
      lifecycleState: 'completed_with_attention',
      currentStage: 'completed',
      degraded: true,
      attentionRequired: true,
      fallbackUsed: true,
      failureStage: null,
      failureCode: null,
      failureMessage: null,
      structuralPath: 'python_script_parser',
      semanticPath: 'gemini_scene_semantic_with_raw_text_fallback',
      extractionSource: null,
      semanticStrategy: 'scene_based',
      qualityGatePassed: false,
      structuralWarnings: [],
      semanticWarnings: ['Semantic unit coverage below threshold'],
      sceneCoverageRatio: 0.83,
      semanticUnitCoverageRatio: 0.78,
    });
  });

  it('keeps parser failure details visible on failed scripts', () => {
    const summary = buildScriptAnalysisLifecycleSummary({
      status: ScriptStatus.FAILED,
      parserMetadata: {
        extractionSource: 'pdf_text',
        analysisPath: {
          structuralPath: 'python_script_parser',
          semanticPath: 'parser_failed_before_semantic',
        },
        analysisLifecycle: {
          currentStage: 'parser_validation',
          lifecycleState: 'failed',
          attentionRequired: true,
          failureStage: 'parser_validation',
          failureCode: 'NOT_A_SCREENPLAY',
          failureMessage: 'The upload does not appear to be a screenplay.',
        },
        structuralWarnings: ['Only one screenplay signal detected'],
      } as any,
    } as any);

    expect(summary).toEqual({
      lifecycleState: 'failed',
      currentStage: 'parser_validation',
      degraded: false,
      attentionRequired: true,
      fallbackUsed: false,
      failureStage: 'parser_validation',
      failureCode: 'NOT_A_SCREENPLAY',
      failureMessage: 'The upload does not appear to be a screenplay.',
      structuralPath: 'python_script_parser',
      semanticPath: 'parser_failed_before_semantic',
      extractionSource: 'pdf_text',
      semanticStrategy: null,
      qualityGatePassed: null,
      structuralWarnings: ['Only one screenplay signal detected'],
      semanticWarnings: [],
      sceneCoverageRatio: null,
      semanticUnitCoverageRatio: null,
    });
  });

  it('keeps degraded-input rejection distinct from degraded success', () => {
    const summary = buildScriptAnalysisLifecycleSummary({
      status: ScriptStatus.FAILED,
      parserMetadata: {
        extractionSource: 'script_parser:pdf_text_heuristic',
        analysisPath: {
          structuralPath: 'python_script_parser',
          semanticPath: 'gemini_scene_semantic',
        },
        analysisLifecycle: {
          currentStage: 'failed',
          lifecycleState: 'failed',
          degraded: false,
          attentionRequired: true,
          fallbackUsed: false,
          failureStage: 'degraded_input_screening',
          failureCode: 'VISUALLY_DEGRADED_INPUT',
          failureMessage:
            'We couldn’t analyze this script reliably because the file is too visually degraded or heavily marked up. Please upload a cleaner PDF or original script export.',
        },
        structuralWarnings: [
          'Parser returned zero dialogue elements. Dialogue/action classification may be damaged.',
        ],
        degradedInputClassification: {
          decision: 'unsupported_degraded',
          fileClass: 'marked_up_pdf',
          reasons: [
            'Page coverage ratio is too low for reliable analysis (0).',
          ],
        },
      } as any,
    } as any);

    expect(summary).toEqual({
      lifecycleState: 'failed',
      currentStage: 'failed',
      degraded: false,
      attentionRequired: true,
      fallbackUsed: false,
      failureStage: 'degraded_input_screening',
      failureCode: 'VISUALLY_DEGRADED_INPUT',
      failureMessage:
        'We couldn’t analyze this script reliably because the file is too visually degraded or heavily marked up. Please upload a cleaner PDF or original script export.',
      structuralPath: 'python_script_parser',
      semanticPath: 'gemini_scene_semantic',
      extractionSource: 'script_parser:pdf_text_heuristic',
      semanticStrategy: null,
      qualityGatePassed: null,
      structuralWarnings: [
        'Parser returned zero dialogue elements. Dialogue/action classification may be damaged.',
      ],
      semanticWarnings: [],
      sceneCoverageRatio: null,
      semanticUnitCoverageRatio: null,
    });
  });
});
