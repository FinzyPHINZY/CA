import { ProjectAnalysisState, ScriptStatus } from '@app/common';
import { buildProjectAnalysisSummaryFromScripts } from './project-analysis-summary.util';

describe('buildProjectAnalysisSummaryFromScripts', () => {
  it('returns IDLE when a project has no scripts', () => {
    expect(buildProjectAnalysisSummaryFromScripts([])).toEqual({
      analysisState: ProjectAnalysisState.IDLE,
      attentionRequired: false,
      totalScripts: 0,
      uploadedScripts: 0,
      processingScripts: 0,
      analyzedScripts: 0,
      failedScripts: 0,
      degradedScripts: 0,
    });
  });

  it('returns PROCESSING when scripts are still queued or running', () => {
    expect(
      buildProjectAnalysisSummaryFromScripts([
        { status: ScriptStatus.UPLOADED },
        { status: ScriptStatus.PROCESSING },
      ]),
    ).toEqual({
      analysisState: ProjectAnalysisState.PROCESSING,
      attentionRequired: false,
      totalScripts: 2,
      uploadedScripts: 1,
      processingScripts: 1,
      analyzedScripts: 0,
      failedScripts: 0,
      degradedScripts: 0,
    });
  });

  it('returns READY when all scripts are analyzed', () => {
    expect(
      buildProjectAnalysisSummaryFromScripts([
        { status: ScriptStatus.ANALYZED },
        { status: ScriptStatus.ANALYZED },
      ]),
    ).toEqual({
      analysisState: ProjectAnalysisState.READY,
      attentionRequired: false,
      totalScripts: 2,
      uploadedScripts: 0,
      processingScripts: 0,
      analyzedScripts: 2,
      failedScripts: 0,
      degradedScripts: 0,
    });
  });

  it('returns PARTIAL and attentionRequired when any script fails', () => {
    expect(
      buildProjectAnalysisSummaryFromScripts([
        { status: ScriptStatus.ANALYZED },
        { status: ScriptStatus.FAILED },
        { status: ScriptStatus.PROCESSING },
      ]),
    ).toEqual({
      analysisState: ProjectAnalysisState.PARTIAL,
      attentionRequired: true,
      totalScripts: 3,
      uploadedScripts: 0,
      processingScripts: 1,
      analyzedScripts: 1,
      failedScripts: 1,
      degradedScripts: 0,
    });
  });

  it('returns PARTIAL when analyzed scripts still require attention', () => {
    expect(
      buildProjectAnalysisSummaryFromScripts([
        {
          status: ScriptStatus.ANALYZED,
          analysisLifecycle: { attentionRequired: true } as any,
        },
        { status: ScriptStatus.ANALYZED },
      ]),
    ).toEqual({
      analysisState: ProjectAnalysisState.PARTIAL,
      attentionRequired: true,
      totalScripts: 2,
      uploadedScripts: 0,
      processingScripts: 0,
      analyzedScripts: 2,
      failedScripts: 0,
      degradedScripts: 1,
    });
  });
});
