import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ScriptAnalysisRegressionManifest {
  version: number;
  suiteName: string;
  cases: ScriptAnalysisRegressionCase[];
}

export interface ScriptAnalysisRegressionCase {
  id: string;
  description: string;
  category: string;
  enabled?: boolean;
  sourcePath?: string | null;
  snapshotPath?: string | null;
  expectations: ScriptAnalysisRegressionExpectations;
}

export interface ScriptAnalysisRegressionExpectations {
  allowedStatuses?: string[];
  requireAttentionRequired?: boolean;
  requireDegraded?: boolean;
  requireFallbackUsed?: boolean;
  requireFailureCode?: string;
  requireClassificationDecision?: string;
  forbidFallback?: boolean;
  minSceneCoverageRatio?: number;
  minSemanticUnitCoverageRatio?: number;
  minPageCoverageRatio?: number;
  minSceneCount?: number;
  minCharacterCount?: number;
  maxStructuralWarnings?: number;
  maxSemanticWarnings?: number;
  requireStructuralPath?: string;
  requireSemanticPath?: string;
  requireFailureStage?: string;
  requiredCharacters?: string[];
  requiredSceneHeadings?: string[];
}

export interface ScriptAnalysisRegressionMetrics {
  status: string | null;
  attentionRequired: boolean | null;
  degraded: boolean | null;
  fallbackUsed: boolean | null;
  failureCode: string | null;
  classificationDecision: string | null;
  structuralPath: string | null;
  semanticPath: string | null;
  failureStage: string | null;
  pageCoverageRatio: number | null;
  sceneCoverageRatio: number | null;
  semanticUnitCoverageRatio: number | null;
  structuralWarnings: string[];
  semanticWarnings: string[];
  sceneCount: number;
  characterCount: number;
  sceneHeadings: string[];
  characterNames: string[];
}

export interface ScriptAnalysisRegressionCaseResult {
  id: string;
  description: string;
  category: string;
  passed: boolean;
  skipped: boolean;
  snapshotPath: string | null;
  reasons: string[];
  metrics: ScriptAnalysisRegressionMetrics | null;
}

export interface ScriptAnalysisRegressionSuiteResult {
  suiteName: string;
  manifestPath: string | null;
  totalCases: number;
  executedCases: number;
  passedCases: number;
  failedCases: number;
  skippedCases: number;
  caseResults: ScriptAnalysisRegressionCaseResult[];
}

interface EvaluateRegressionSuiteOptions {
  baseDir?: string;
  includeDisabled?: boolean;
  manifestPath?: string | null;
  loadSnapshot?: (
    testCase: ScriptAnalysisRegressionCase,
    resolvedSnapshotPath: string | null,
  ) => unknown;
}

export function loadRegressionManifest(
  manifestPath: string,
): ScriptAnalysisRegressionManifest {
  const absoluteManifestPath = path.resolve(manifestPath);
  const raw = fs.readFileSync(absoluteManifestPath, 'utf8');
  const manifest = JSON.parse(raw) as ScriptAnalysisRegressionManifest;
  if (!manifest || !Array.isArray(manifest.cases)) {
    throw new Error(
      `Regression manifest ${absoluteManifestPath} is missing a valid cases array`,
    );
  }
  return manifest;
}

export function evaluateRegressionSuite(
  manifest: ScriptAnalysisRegressionManifest,
  options: EvaluateRegressionSuiteOptions = {},
): ScriptAnalysisRegressionSuiteResult {
  const caseResults = manifest.cases.map((testCase) =>
    evaluateRegressionCase(testCase, options),
  );
  const executedCases = caseResults.filter((result) => !result.skipped).length;
  const passedCases = caseResults.filter((result) => result.passed).length;
  const failedCases = caseResults.filter(
    (result) => !result.skipped && !result.passed,
  ).length;
  const skippedCases = caseResults.filter((result) => result.skipped).length;

  return {
    suiteName: manifest.suiteName,
    manifestPath: options.manifestPath || null,
    totalCases: caseResults.length,
    executedCases,
    passedCases,
    failedCases,
    skippedCases,
    caseResults,
  };
}

export function formatRegressionSuiteReport(
  result: ScriptAnalysisRegressionSuiteResult,
): string {
  const lines = [
    `Suite: ${result.suiteName}`,
    `Manifest: ${result.manifestPath || 'n/a'}`,
    `Cases: ${result.executedCases}/${result.totalCases} executed, ${result.passedCases} passed, ${result.failedCases} failed, ${result.skippedCases} skipped`,
  ];

  for (const caseResult of result.caseResults) {
    const status = caseResult.skipped
      ? 'SKIPPED'
      : caseResult.passed
        ? 'PASS'
        : 'FAIL';
    lines.push(
      `- [${status}] ${caseResult.id} (${caseResult.category}) ${caseResult.description}`,
    );
    if (caseResult.snapshotPath) {
      lines.push(`  snapshot: ${caseResult.snapshotPath}`);
    }
    if (caseResult.metrics) {
      lines.push(
        `  metrics: status=${caseResult.metrics.status || 'n/a'}, scenes=${caseResult.metrics.sceneCount}, characters=${caseResult.metrics.characterCount}, pageCoverage=${formatRatio(caseResult.metrics.pageCoverageRatio)}, sceneCoverage=${formatRatio(caseResult.metrics.sceneCoverageRatio)}, semanticCoverage=${formatRatio(caseResult.metrics.semanticUnitCoverageRatio)}`,
      );
    }
    for (const reason of caseResult.reasons) {
      lines.push(`  reason: ${reason}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function evaluateRegressionCase(
  testCase: ScriptAnalysisRegressionCase,
  options: EvaluateRegressionSuiteOptions,
): ScriptAnalysisRegressionCaseResult {
  if (testCase.enabled === false && !options.includeDisabled) {
    return {
      id: testCase.id,
      description: testCase.description,
      category: testCase.category,
      passed: true,
      skipped: true,
      snapshotPath: resolveOptionalPath(options.baseDir, testCase.snapshotPath),
      reasons: ['Case disabled in manifest'],
      metrics: null,
    };
  }

  const resolvedSnapshotPath = resolveOptionalPath(
    options.baseDir,
    testCase.snapshotPath,
  );
  if (!resolvedSnapshotPath) {
    return {
      id: testCase.id,
      description: testCase.description,
      category: testCase.category,
      passed: false,
      skipped: false,
      snapshotPath: null,
      reasons: ['snapshotPath is required for enabled regression cases'],
      metrics: null,
    };
  }

  let snapshot: unknown;
  try {
    snapshot = options.loadSnapshot
      ? options.loadSnapshot(testCase, resolvedSnapshotPath)
      : JSON.parse(fs.readFileSync(resolvedSnapshotPath, 'utf8'));
  } catch (error: any) {
    return {
      id: testCase.id,
      description: testCase.description,
      category: testCase.category,
      passed: false,
      skipped: false,
      snapshotPath: resolvedSnapshotPath,
      reasons: [
        `Unable to read snapshot: ${error?.message || 'unknown error'}`,
      ],
      metrics: null,
    };
  }

  const metrics = extractRegressionMetrics(snapshot);
  const reasons = validateRegressionExpectations(
    testCase.expectations,
    metrics,
  );

  return {
    id: testCase.id,
    description: testCase.description,
    category: testCase.category,
    passed: reasons.length === 0,
    skipped: false,
    snapshotPath: resolvedSnapshotPath,
    reasons,
    metrics,
  };
}

export function extractRegressionMetrics(
  snapshot: unknown,
): ScriptAnalysisRegressionMetrics {
  const normalizedSnapshot = normalizeSnapshot(snapshot);
  const parserMetadata = pickObject(normalizedSnapshot, [
    ['parserMetadata'],
    ['result', 'parserMetadata'],
    ['script', 'parserMetadata'],
    ['data', 'parserMetadata'],
  ]);
  const analysisLifecycle =
    pickObject(normalizedSnapshot, [
      ['analysisLifecycle'],
      ['result', 'analysisLifecycle'],
      ['script', 'analysisLifecycle'],
      ['data', 'analysisLifecycle'],
    ]) ||
    pickObject(parserMetadata, [['analysisLifecycle']]) ||
    {};
  const semanticAnalysis =
    pickObject(normalizedSnapshot, [
      ['semanticAnalysis'],
      ['result', 'semanticAnalysis'],
      ['script', 'semanticAnalysis'],
    ]) ||
    pickObject(parserMetadata, [['semanticAnalysis']]) ||
    {};
  const degradedInputClassification =
    pickObject(normalizedSnapshot, [
      ['degradedInputClassification'],
      ['result', 'degradedInputClassification'],
      ['script', 'degradedInputClassification'],
      ['data', 'degradedInputClassification'],
    ]) ||
    pickObject(parserMetadata, [['degradedInputClassification']]) ||
    {};
  const analysisPath =
    pickObject(normalizedSnapshot, [
      ['analysisPath'],
      ['result', 'analysisPath'],
      ['script', 'analysisPath'],
    ]) ||
    pickObject(parserMetadata, [['analysisPath']]) ||
    {};

  const scenes = pickArray(normalizedSnapshot, [
    ['scenes'],
    ['result', 'scenes'],
    ['script', 'scenes'],
    ['data', 'scenes'],
  ]);
  const characters = pickArray(normalizedSnapshot, [
    ['characters'],
    ['result', 'characters'],
    ['script', 'characters'],
    ['data', 'characters'],
  ]);

  const sceneHeadings = scenes
    .map((scene) => readString(scene, [['heading']]))
    .filter((heading): heading is string => Boolean(heading));
  const characterNames = characters
    .map((character) =>
      typeof character === 'string'
        ? character
        : readString(character, [['name']]) || null,
    )
    .filter((name): name is string => Boolean(name));

  return {
    status:
      readString(normalizedSnapshot, [
        ['status'],
        ['result', 'status'],
        ['script', 'status'],
        ['data', 'status'],
      ]) || null,
    attentionRequired:
      readBoolean(analysisLifecycle, [['attentionRequired']]) ?? null,
    degraded: readBoolean(analysisLifecycle, [['degraded']]) ?? null,
    fallbackUsed: readBoolean(analysisLifecycle, [['fallbackUsed']]) ?? null,
    failureCode: readString(analysisLifecycle, [['failureCode']]) || null,
    classificationDecision:
      readString(degradedInputClassification, [['decision']]) || null,
    structuralPath:
      readString(analysisLifecycle, [['structuralPath']]) ||
      readString(analysisPath, [['structuralPath']]) ||
      null,
    semanticPath:
      readString(analysisLifecycle, [['semanticPath']]) ||
      readString(analysisPath, [['semanticPath']]) ||
      null,
    failureStage: readString(analysisLifecycle, [['failureStage']]) || null,
    pageCoverageRatio:
      readNumber(parserMetadata, [['coverageRatio'], ['pageCoverageRatio']]) ??
      null,
    sceneCoverageRatio:
      readNumber(analysisLifecycle, [['sceneCoverageRatio']]) ??
      readNumber(semanticAnalysis, [['sceneCoverageRatio']]) ??
      null,
    semanticUnitCoverageRatio:
      readNumber(analysisLifecycle, [['semanticUnitCoverageRatio']]) ??
      readNumber(semanticAnalysis, [['semanticUnitCoverageRatio']]) ??
      null,
    structuralWarnings:
      readStringArray(analysisLifecycle, [['structuralWarnings']]) ||
      readStringArray(parserMetadata, [['structuralWarnings']]) ||
      [],
    semanticWarnings:
      readStringArray(analysisLifecycle, [['semanticWarnings']]) ||
      readStringArray(semanticAnalysis, [['qualityGate', 'reasons']]) ||
      [],
    sceneCount: scenes.length,
    characterCount: characterNames.length,
    sceneHeadings,
    characterNames,
  };
}

function validateRegressionExpectations(
  expectations: ScriptAnalysisRegressionExpectations,
  metrics: ScriptAnalysisRegressionMetrics,
): string[] {
  const reasons: string[] = [];

  if (
    expectations.allowedStatuses?.length &&
    (!metrics.status || !expectations.allowedStatuses.includes(metrics.status))
  ) {
    reasons.push(
      `Expected status in [${expectations.allowedStatuses.join(', ')}] but received ${metrics.status || 'null'}`,
    );
  }

  checkBooleanExpectation(
    reasons,
    'attentionRequired',
    expectations.requireAttentionRequired,
    metrics.attentionRequired,
  );
  checkBooleanExpectation(
    reasons,
    'degraded',
    expectations.requireDegraded,
    metrics.degraded,
  );
  checkBooleanExpectation(
    reasons,
    'fallbackUsed',
    expectations.requireFallbackUsed,
    metrics.fallbackUsed,
  );

  if (expectations.forbidFallback && metrics.fallbackUsed) {
    reasons.push('Fallback was used but manifest forbids it');
  }

  checkMinimumExpectation(
    reasons,
    'pageCoverageRatio',
    expectations.minPageCoverageRatio,
    metrics.pageCoverageRatio,
  );
  checkMinimumExpectation(
    reasons,
    'sceneCoverageRatio',
    expectations.minSceneCoverageRatio,
    metrics.sceneCoverageRatio,
  );
  checkMinimumExpectation(
    reasons,
    'semanticUnitCoverageRatio',
    expectations.minSemanticUnitCoverageRatio,
    metrics.semanticUnitCoverageRatio,
  );
  checkMinimumExpectation(
    reasons,
    'sceneCount',
    expectations.minSceneCount,
    metrics.sceneCount,
  );
  checkMinimumExpectation(
    reasons,
    'characterCount',
    expectations.minCharacterCount,
    metrics.characterCount,
  );
  checkMaximumExpectation(
    reasons,
    'structuralWarnings',
    expectations.maxStructuralWarnings,
    metrics.structuralWarnings.length,
  );
  checkMaximumExpectation(
    reasons,
    'semanticWarnings',
    expectations.maxSemanticWarnings,
    metrics.semanticWarnings.length,
  );

  if (
    expectations.requireFailureCode &&
    metrics.failureCode !== expectations.requireFailureCode
  ) {
    reasons.push(
      `Expected failureCode=${expectations.requireFailureCode} but received ${metrics.failureCode || 'null'}`,
    );
  }
  if (
    expectations.requireClassificationDecision &&
    metrics.classificationDecision !==
      expectations.requireClassificationDecision
  ) {
    reasons.push(
      `Expected classificationDecision=${expectations.requireClassificationDecision} but received ${metrics.classificationDecision || 'null'}`,
    );
  }
  if (
    expectations.requireStructuralPath &&
    metrics.structuralPath !== expectations.requireStructuralPath
  ) {
    reasons.push(
      `Expected structuralPath=${expectations.requireStructuralPath} but received ${metrics.structuralPath || 'null'}`,
    );
  }
  if (
    expectations.requireSemanticPath &&
    metrics.semanticPath !== expectations.requireSemanticPath
  ) {
    reasons.push(
      `Expected semanticPath=${expectations.requireSemanticPath} but received ${metrics.semanticPath || 'null'}`,
    );
  }
  if (
    expectations.requireFailureStage &&
    metrics.failureStage !== expectations.requireFailureStage
  ) {
    reasons.push(
      `Expected failureStage=${expectations.requireFailureStage} but received ${metrics.failureStage || 'null'}`,
    );
  }

  if (expectations.requiredCharacters?.length) {
    const availableNames = new Set(
      metrics.characterNames.map((name) => name.toUpperCase()),
    );
    for (const requiredCharacter of expectations.requiredCharacters) {
      if (!availableNames.has(requiredCharacter.toUpperCase())) {
        reasons.push(`Missing required character ${requiredCharacter}`);
      }
    }
  }

  if (expectations.requiredSceneHeadings?.length) {
    const availableHeadings = new Set(
      metrics.sceneHeadings.map((heading) => heading.toUpperCase()),
    );
    for (const requiredHeading of expectations.requiredSceneHeadings) {
      if (!availableHeadings.has(requiredHeading.toUpperCase())) {
        reasons.push(`Missing required scene heading ${requiredHeading}`);
      }
    }
  }

  return reasons;
}

function normalizeSnapshot(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== 'object') {
    return {};
  }
  return snapshot as Record<string, unknown>;
}

function resolveOptionalPath(
  baseDir: string | undefined,
  relativeOrAbsolutePath?: string | null,
): string | null {
  if (!relativeOrAbsolutePath) {
    return null;
  }
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.resolve(baseDir || process.cwd(), relativeOrAbsolutePath);
}

function pickValue(source: unknown, candidatePaths: string[][]): unknown {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const candidatePath of candidatePaths) {
    let current: unknown = source;
    let found = true;
    for (const pathPart of candidatePath) {
      if (!current || typeof current !== 'object' || !(pathPart in current)) {
        found = false;
        break;
      }
      current = (current as Record<string, unknown>)[pathPart];
    }
    if (found) {
      return current;
    }
  }

  return undefined;
}

function pickObject(
  source: unknown,
  candidatePaths: string[][],
): Record<string, unknown> | null {
  const value = pickValue(source, candidatePaths);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickArray(source: unknown, candidatePaths: string[][]): unknown[] {
  const value = pickValue(source, candidatePaths);
  return Array.isArray(value) ? value : [];
}

function readString(
  source: unknown,
  candidatePaths: string[][],
): string | null {
  const value = pickValue(source, candidatePaths);
  return typeof value === 'string' ? value : null;
}

function readNumber(
  source: unknown,
  candidatePaths: string[][],
): number | null {
  const value = pickValue(source, candidatePaths);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(
  source: unknown,
  candidatePaths: string[][],
): boolean | null {
  const value = pickValue(source, candidatePaths);
  return typeof value === 'boolean' ? value : null;
}

function readStringArray(
  source: unknown,
  candidatePaths: string[][],
): string[] | null {
  const value = pickValue(source, candidatePaths);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : null;
}

function checkBooleanExpectation(
  reasons: string[],
  label: string,
  expected: boolean | undefined,
  actual: boolean | null,
) {
  if (typeof expected !== 'boolean') {
    return;
  }
  if (actual !== expected) {
    reasons.push(`Expected ${label}=${expected} but received ${actual}`);
  }
}

function checkMinimumExpectation(
  reasons: string[],
  label: string,
  expectedMinimum: number | undefined,
  actual: number | null,
) {
  if (typeof expectedMinimum !== 'number') {
    return;
  }
  if (typeof actual !== 'number') {
    reasons.push(`Expected ${label} >= ${expectedMinimum} but received null`);
    return;
  }
  if (actual < expectedMinimum) {
    reasons.push(
      `Expected ${label} >= ${expectedMinimum} but received ${actual}`,
    );
  }
}

function checkMaximumExpectation(
  reasons: string[],
  label: string,
  expectedMaximum: number | undefined,
  actual: number | null,
) {
  if (typeof expectedMaximum !== 'number') {
    return;
  }
  if (typeof actual !== 'number') {
    reasons.push(`Expected ${label} <= ${expectedMaximum} but received null`);
    return;
  }
  if (actual > expectedMaximum) {
    reasons.push(
      `Expected ${label} <= ${expectedMaximum} but received ${actual}`,
    );
  }
}

function formatRatio(value: number | null): string {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}
