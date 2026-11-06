export type DegradedInputDecision =
  | 'supported'
  | 'degraded_but_allowed'
  | 'unsupported_degraded';

export type DegradedInputFileClass =
  | 'clean_full_script'
  | 'clean_short_side'
  | 'moderate_noise'
  | 'marked_up_pdf'
  | 'watermark_dominated_pdf'
  | 'ocr_corrupted_pdf'
  | 'structurally_unreliable_pdf';

export interface DegradedInputClassification {
  decision: DegradedInputDecision;
  reasons: string[];
  warnings: string[];
  fileClass: DegradedInputFileClass;
  failureCode: 'VISUALLY_DEGRADED_INPUT' | null;
  evaluatedAt: string;
  gateVersion: 'mvp_v1';
}

export interface DegradedInputSignalBundle {
  pageCount: number | null;
  parsedPageCount: number | null;
  pageCoverageRatio: number | null;
  sceneCount: number | null;
  sceneHeadings: string[];
  structureConfidenceScore: number | null;
  lowConfidenceFlag: boolean;
  watermarkDetected: boolean;
  structuralWarnings: string[];
  structuralClassificationWarnings: string[];
  qualityGatePassed: boolean | null;
  qualityGateReasons: string[];
  fallbackUsed: boolean;
  characterLineCounts: Array<{ name: string; lineCount: number }>;
  analysisCharacterNames: string[];
}

const FAILURE_CODE = 'VISUALLY_DEGRADED_INPUT' as const;

export function classifyDegradedInput(
  input: DegradedInputSignalBundle,
): DegradedInputClassification {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const pageCount = input.pageCount ?? 0;
  const isShortSide = pageCount > 0 && pageCount <= 3;
  const pageCoverageRatio = input.pageCoverageRatio;
  const parsedPageCount = input.parsedPageCount ?? 0;
  const sceneCount = input.sceneCount ?? 0;
  const sceneHeadings = input.sceneHeadings || [];
  const topCharacterEntries = (input.characterLineCounts || [])
    .slice()
    .sort((a, b) => (b.lineCount || 0) - (a.lineCount || 0))
    .slice(0, 8);
  const gibberishCharacterCount = topCharacterEntries.filter((entry) =>
    isImplausibleCharacterName(entry.name),
  ).length;
  const plausibleCharacterCount =
    topCharacterEntries.length - gibberishCharacterCount;
  const allSceneHeadingsGeneric =
    sceneHeadings.length > 0 &&
    sceneHeadings.every((heading) => heading.trim() === '(Document)');

  // Structural rescue: if the parser found real screenplay signals (scenes with
  // non-generic headings AND plausible character names), the file is structurally
  // sound even if coverage metrics are low due to watermarks, handwriting, or
  // scan artifacts. Common for audition sides from Breakdown Services, etc.
  const hasStrongStructuralSignals =
    sceneCount >= 1 && !allSceneHeadingsGeneric && plausibleCharacterCount >= 2;

  // Dialogue rescue: pasted text, monologues, and scene excerpts often lack
  // INT./EXT. headings, so the parser wraps everything into a single "(Document)"
  // scene. This is valid if the parser found real dialogue structure (at least 1
  // plausible character with multiple lines). Don't reject these as degraded input.
  const hasDialogueStructure =
    topCharacterEntries.filter(
      (e) => e.lineCount >= 2 && !isImplausibleCharacterName(e.name),
    ).length >= 1;

  if (
    typeof pageCoverageRatio === 'number' &&
    pageCoverageRatio <= 0.1 &&
    !hasStrongStructuralSignals
  ) {
    reasons.push(
      `Page coverage ratio is too low for reliable analysis (${pageCoverageRatio}).`,
    );
  }

  if (pageCount > 0 && parsedPageCount === 0) {
    reasons.push('Parser did not recover any usable pages.');
  }

  if (
    isShortSide &&
    pageCount > 0 &&
    typeof pageCoverageRatio === 'number' &&
    pageCoverageRatio < 0.8 &&
    !hasStrongStructuralSignals
  ) {
    if (pageCoverageRatio < 0.3) {
      reasons.push(
        `Short script coverage is below the supported threshold (${pageCoverageRatio}).`,
      );
    } else {
      warnings.push(
        `Short script coverage is below ideal (${pageCoverageRatio}), but not critically low.`,
      );
    }
  }

  if (
    allSceneHeadingsGeneric &&
    (parsedPageCount === 0 || sceneCount <= 1) &&
    !hasDialogueStructure
  ) {
    reasons.push(
      'Recovered structure collapsed into a generic document block.',
    );
  }

  if (
    typeof input.structureConfidenceScore === 'number' &&
    input.structureConfidenceScore < 0.65 &&
    gibberishCharacterCount >= 5
  ) {
    reasons.push(
      'Structure confidence is low and extracted character cues are dominated by gibberish.',
    );
  }

  if (gibberishCharacterCount >= 5) {
    reasons.push(
      'Extracted character cues are dominated by implausible names.',
    );
  }

  if (input.fallbackUsed && input.qualityGatePassed === false) {
    reasons.push(
      'Scene-based analysis quality gates failed and fallback was required.',
    );
  }

  if (
    hasUnrelatedSummaryIndicators(
      input.analysisCharacterNames,
      topCharacterEntries.map((entry) => entry.name),
    )
  ) {
    reasons.push(
      'Semantic output appears inconsistent with recovered structural character cues.',
    );
  }

  if (
    input.watermarkDetected &&
    typeof pageCoverageRatio === 'number' &&
    gibberishCharacterCount === 0
  ) {
    warnings.push(
      'Watermark detected, but structure remained strong enough to continue.',
    );
  }

  if (
    (hasStrongStructuralSignals || hasDialogueStructure) &&
    reasons.length > 0
  ) {
    // Downgrade hard rejections to warnings when structural signals are strong
    // or real dialogue structure exists (e.g., pasted text with no scene headings).
    // This prevents legitimate audition sides and scene excerpts from being rejected.
    const rescued = reasons.splice(0, reasons.length);
    for (const r of rescued) {
      warnings.push(`[rescued] ${r}`);
    }
  }

  if (input.lowConfidenceFlag && reasons.length === 0) {
    warnings.push(
      'Low-confidence extraction detected, but hard rejection gates did not fire.',
    );
  }

  for (const warning of input.structuralWarnings || []) {
    if (
      warning.includes('header/footer') ||
      warning.includes('watermark') ||
      warning.includes('low confidence')
    ) {
      warnings.push(warning);
    }
  }

  const decision: DegradedInputDecision =
    reasons.length > 0
      ? 'unsupported_degraded'
      : warnings.length > 0
        ? 'degraded_but_allowed'
        : 'supported';

  return {
    decision,
    reasons: Array.from(new Set(reasons)),
    warnings: Array.from(new Set(warnings)),
    fileClass: inferFileClass({
      decision,
      watermarkDetected: input.watermarkDetected,
      gibberishCharacterCount,
      structuralCollapse: allSceneHeadingsGeneric,
      isShortSide,
    }),
    failureCode: decision === 'unsupported_degraded' ? FAILURE_CODE : null,
    evaluatedAt: new Date().toISOString(),
    gateVersion: 'mvp_v1',
  };
}

function inferFileClass(input: {
  decision: DegradedInputDecision;
  watermarkDetected: boolean;
  gibberishCharacterCount: number;
  structuralCollapse: boolean;
  isShortSide: boolean;
}): DegradedInputFileClass {
  if (input.decision === 'supported') {
    return input.isShortSide ? 'clean_short_side' : 'clean_full_script';
  }

  if (input.decision === 'degraded_but_allowed') {
    return 'moderate_noise';
  }

  if (input.watermarkDetected) {
    return 'watermark_dominated_pdf';
  }

  if (input.gibberishCharacterCount >= 5) {
    return 'ocr_corrupted_pdf';
  }

  if (input.structuralCollapse) {
    return 'structurally_unreliable_pdf';
  }

  return 'marked_up_pdf';
}

function hasUnrelatedSummaryIndicators(
  analysisCharacterNames: string[],
  structuralCharacterNames: string[],
): boolean {
  const cleanAnalysis = analysisCharacterNames
    .map(normalizeName)
    .filter(Boolean)
    .slice(0, 8);
  const cleanStructural = structuralCharacterNames
    .map(normalizeName)
    .filter(Boolean)
    .filter((name) => !isImplausibleCharacterName(name))
    .slice(0, 8);

  if (cleanAnalysis.length === 0 || cleanStructural.length === 0) {
    return false;
  }

  const overlap = cleanAnalysis.filter((name) =>
    cleanStructural.includes(name),
  ).length;

  return overlap === 0;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function isImplausibleCharacterName(name: string): boolean {
  const normalized = normalizeName(name);
  if (!normalized) {
    return true;
  }

  if (normalized === '(DOCUMENT)') {
    return true;
  }

  const letters = (normalized.match(/[A-Z]/g) || []).length;
  const digits = (normalized.match(/\d/g) || []).length;
  const punctuation = (normalized.match(/[^A-Z0-9\s]/g) || []).length;

  if (letters === 0) {
    return true;
  }

  if (digits > letters) {
    return true;
  }

  if (punctuation >= letters) {
    return true;
  }

  if (/^[-:\d\s]+$/.test(normalized)) {
    return true;
  }

  if (normalized.length <= 3 && letters <= 1) {
    return true;
  }

  return false;
}
