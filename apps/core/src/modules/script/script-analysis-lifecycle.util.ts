import { Script, ScriptStatus } from '@app/common';

export interface ScriptAnalysisLifecycleSummary {
  lifecycleState: string;
  currentStage: string;
  degraded: boolean;
  attentionRequired: boolean;
  fallbackUsed: boolean;
  failureStage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  structuralPath: string | null;
  semanticPath: string | null;
  extractionSource: string | null;
  semanticStrategy: string | null;
  qualityGatePassed: boolean | null;
  structuralWarnings: string[];
  semanticWarnings: string[];
  sceneCoverageRatio: number | null;
  semanticUnitCoverageRatio: number | null;
}

export function buildScriptAnalysisLifecycleSummary(
  script: Pick<Script, 'status' | 'parserMetadata'> | null | undefined,
): ScriptAnalysisLifecycleSummary {
  const parserMetadata = (script as any)?.parserMetadata || {};
  const semanticAnalysis = parserMetadata.semanticAnalysis || {};
  const analysisLifecycle = parserMetadata.analysisLifecycle || {};
  const analysisPath = parserMetadata.analysisPath || {};
  const qualityGate = semanticAnalysis.qualityGate || {};
  const structuralWarnings = Array.isArray(parserMetadata.structuralWarnings)
    ? parserMetadata.structuralWarnings
    : [];
  const semanticWarnings = Array.isArray(qualityGate.reasons)
    ? qualityGate.reasons
    : [];

  const fallbackUsed = Boolean(
    analysisLifecycle.fallbackUsed ?? semanticAnalysis.synthesisFallbackUsed,
  );
  const degraded =
    typeof analysisLifecycle.degraded === 'boolean'
      ? analysisLifecycle.degraded
      : Boolean(
          fallbackUsed ||
            (Array.isArray(semanticWarnings) && semanticWarnings.length > 0),
        );
  const currentStage =
    analysisLifecycle.currentStage ||
    (script?.status === ScriptStatus.UPLOADED
      ? 'queued'
      : script?.status === ScriptStatus.PROCESSING
        ? 'processing'
        : script?.status === ScriptStatus.FAILED
          ? 'failed'
          : 'completed');
  const lifecycleState =
    analysisLifecycle.lifecycleState ||
    (script?.status === ScriptStatus.UPLOADED
      ? 'queued'
      : script?.status === ScriptStatus.PROCESSING
        ? 'processing'
        : script?.status === ScriptStatus.FAILED
          ? 'failed'
          : degraded
            ? 'completed_with_attention'
            : 'completed');

  return {
    lifecycleState,
    currentStage,
    degraded,
    attentionRequired:
      typeof analysisLifecycle.attentionRequired === 'boolean'
        ? analysisLifecycle.attentionRequired
        : Boolean(degraded || script?.status === ScriptStatus.FAILED),
    fallbackUsed,
    failureStage: analysisLifecycle.failureStage || null,
    failureCode: analysisLifecycle.failureCode || null,
    failureMessage: analysisLifecycle.failureMessage || null,
    structuralPath: analysisPath.structuralPath || null,
    semanticPath: analysisPath.semanticPath || null,
    extractionSource:
      analysisLifecycle.extractionSource ||
      parserMetadata.extractionSource ||
      null,
    semanticStrategy: semanticAnalysis.semanticStrategy || null,
    qualityGatePassed:
      typeof qualityGate.passed === 'boolean' ? qualityGate.passed : null,
    structuralWarnings,
    semanticWarnings,
    sceneCoverageRatio:
      typeof semanticAnalysis.sceneCoverageRatio === 'number'
        ? semanticAnalysis.sceneCoverageRatio
        : null,
    semanticUnitCoverageRatio:
      typeof semanticAnalysis.semanticUnitCoverageRatio === 'number'
        ? semanticAnalysis.semanticUnitCoverageRatio
        : null,
  };
}
