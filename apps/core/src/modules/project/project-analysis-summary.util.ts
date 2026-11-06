import { ProjectAnalysisState, Script, ScriptStatus } from '@app/common';
import { ScriptAnalysisLifecycleSummary } from '../script/script-analysis-lifecycle.util';

export interface ProjectAnalysisSummary {
  analysisState: ProjectAnalysisState;
  attentionRequired: boolean;
  totalScripts: number;
  uploadedScripts: number;
  processingScripts: number;
  analyzedScripts: number;
  failedScripts: number;
  degradedScripts: number;
}

export interface ProjectScriptStatusCounts {
  totalScripts: number;
  uploadedScripts: number;
  processingScripts: number;
  analyzedScripts: number;
  failedScripts: number;
  degradedScripts: number;
}

export function buildProjectAnalysisSummary(
  counts: ProjectScriptStatusCounts,
): ProjectAnalysisSummary {
  const {
    totalScripts,
    uploadedScripts,
    processingScripts,
    analyzedScripts,
    failedScripts,
    degradedScripts,
  } = counts;

  let analysisState = ProjectAnalysisState.PARTIAL;
  if (totalScripts === 0) {
    analysisState = ProjectAnalysisState.IDLE;
  } else if (failedScripts > 0 || degradedScripts > 0) {
    analysisState = ProjectAnalysisState.PARTIAL;
  } else if (analyzedScripts === totalScripts) {
    analysisState = ProjectAnalysisState.READY;
  } else if (uploadedScripts > 0 || processingScripts > 0) {
    analysisState = ProjectAnalysisState.PROCESSING;
  }

  return {
    analysisState,
    attentionRequired: failedScripts > 0 || degradedScripts > 0,
    totalScripts,
    uploadedScripts,
    processingScripts,
    analyzedScripts,
    failedScripts,
    degradedScripts,
  };
}

export function buildProjectAnalysisSummaryFromScripts(
  scripts: Array<
    Pick<Script, 'status'> & {
      analysisLifecycle?: ScriptAnalysisLifecycleSummary;
    }
  >,
): ProjectAnalysisSummary {
  const counts = {
    totalScripts: scripts.length,
    uploadedScripts: 0,
    processingScripts: 0,
    analyzedScripts: 0,
    failedScripts: 0,
    degradedScripts: 0,
  };

  for (const script of scripts) {
    switch (script.status) {
      case ScriptStatus.UPLOADED:
        counts.uploadedScripts += 1;
        break;
      case ScriptStatus.PROCESSING:
        counts.processingScripts += 1;
        break;
      case ScriptStatus.ANALYZED:
        counts.analyzedScripts += 1;
        break;
      case ScriptStatus.FAILED:
        counts.failedScripts += 1;
        break;
      default:
        break;
    }

    if (
      script.status === ScriptStatus.ANALYZED &&
      script.analysisLifecycle?.attentionRequired
    ) {
      counts.degradedScripts += 1;
    }
  }

  return buildProjectAnalysisSummary(counts);
}
