

import * as fs from 'fs';
import * as path from 'path';

interface GoldenPair {
  question: string;
  expectedClass: string;
  expectedAnswer: string | null;
  expectedCitations: Array<{ sceneNumber: number }>;
  expectedRefusal: boolean;
}

interface GoldenFile {
  scriptId: string;
  scriptTitle: string;
  pairs: GoldenPair[];
}

interface EvalResult {
  question: string;
  expectedClass: string;
  actualClass: string;
  classCorrect: boolean;
  expectedRefusal: boolean;
  actualRefusal: boolean;
  refusalCorrect: boolean;
  citationPrecision: number;
  citationRecall: number;
  qualityScore: number;
  hallucinated: boolean;
  latencyMs: number;
  error?: string;
}

interface EvalSummary {
  totalPairs: number;
  classAccuracy: number;
  refusalPrecision: number;
  avgCitationPrecision: number;
  avgCitationRecall: number;
  avgQualityScore: number;
  hallucinationRate: number;
  avgLatencyMs: number;
  passed: boolean;
}

const CLASS_ACCURACY_THRESHOLD = 0.9;
const HALLUCINATION_THRESHOLD = 0.01;

function loadGoldenFiles(specificFile?: string): GoldenFile[] {
  const goldenDir = path.join(__dirname, 'golden');
  const files = specificFile
    ? [specificFile]
    : fs.readdirSync(goldenDir).filter((f) => f.endsWith('.json'));

  return files.map((f) => {
    const filePath = path.join(goldenDir, f);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GoldenFile;
  });
}

function computeCitationMetrics(
  expected: Array<{ sceneNumber: number }>,
  actual: Array<{ sceneNumber?: number | null }>,
): { precision: number; recall: number } {
  if (!expected.length && !actual.length) return { precision: 1, recall: 1 };
  if (!expected.length) return { precision: actual.length ? 0 : 1, recall: 1 };
  if (!actual.length) return { precision: 1, recall: 0 };

  const expectedSet = new Set(expected.map((c) => c.sceneNumber));
  const actualSet = new Set(actual.map((c) => c.sceneNumber).filter(Boolean));

  let hits = 0;
  for (const s of actualSet) {
    if (expectedSet.has(s!)) hits++;
  }

  return {
    precision: actualSet.size ? hits / actualSet.size : 0,
    recall: expectedSet.size ? hits / expectedSet.size : 0,
  };
}

async function runEval(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));
  const specificFile = fileArg?.split('=')[1];

  const goldenFiles = loadGoldenFiles(specificFile);
  const allResults: EvalResult[] = [];

  console.log('=== Script Q&A Eval Harness ===\n');

  for (const golden of goldenFiles) {
    if (golden.scriptId === 'REPLACE_WITH_REAL_SCRIPT_ID') {
      console.log(`Skipping example file (placeholder scriptId)\n`);
      continue;
    }

    console.log(`Script: ${golden.scriptTitle} (${golden.scriptId})`);
    console.log(`  Pairs: ${golden.pairs.length}`);

    for (const pair of golden.pairs) {
      const result: EvalResult = {
        question: pair.question,
        expectedClass: pair.expectedClass,
        actualClass: 'UNKNOWN',
        classCorrect: false,
        expectedRefusal: pair.expectedRefusal,
        actualRefusal: false,
        refusalCorrect: false,
        citationPrecision: 0,
        citationRecall: 0,
        qualityScore: 0,
        hallucinated: false,
        latencyMs: 0,
      };

      try {
        result.error = 'PIPELINE_NOT_CONNECTED';
        console.log(`  [SKIP] "${pair.question}" — pipeline not connected in eval mode`);
      } catch (err: any) {
        result.error = err.message;
      }

      allResults.push(result);
    }
    console.log('');
  }

  if (!allResults.length) {
    console.log('No golden pairs to evaluate (only example files found).');
    console.log('Add real golden files to apps/ai_service/test/script-qa-eval/golden/');
    console.log('\nPASS (no pairs to evaluate)\n');
    return;
  }

  const connected = allResults.filter((r) => !r.error);

  if (!connected.length) {
    console.log('All pairs skipped (pipeline not connected).');
    console.log('To run real eval, connect the pipeline in eval-runner.ts.\n');
    return;
  }

  const summary = computeSummary(connected);
  printSummary(summary);

  if (!summary.passed) {
    process.exit(1);
  }
}

function computeSummary(results: EvalResult[]): EvalSummary {
  const n = results.length;
  const classCorrect = results.filter((r) => r.classCorrect).length;
  const refusalPairs = results.filter((r) => r.expectedRefusal);
  const refusalCorrect = refusalPairs.filter((r) => r.refusalCorrect).length;
  const hallucinated = results.filter((r) => r.hallucinated).length;

  const classAccuracy = n ? classCorrect / n : 0;
  const hallucinationRate = n ? hallucinated / n : 0;

  return {
    totalPairs: n,
    classAccuracy,
    refusalPrecision: refusalPairs.length
      ? refusalCorrect / refusalPairs.length
      : 1,
    avgCitationPrecision:
      results.reduce((s, r) => s + r.citationPrecision, 0) / n,
    avgCitationRecall:
      results.reduce((s, r) => s + r.citationRecall, 0) / n,
    avgQualityScore:
      results.reduce((s, r) => s + r.qualityScore, 0) / n,
    hallucinationRate,
    avgLatencyMs:
      results.reduce((s, r) => s + r.latencyMs, 0) / n,
    passed:
      classAccuracy >= CLASS_ACCURACY_THRESHOLD &&
      hallucinationRate <= HALLUCINATION_THRESHOLD,
  };
}

function printSummary(s: EvalSummary): void {
  console.log('=== Eval Summary ===');
  console.log(`Total pairs:          ${s.totalPairs}`);
  console.log(`Class accuracy:       ${(s.classAccuracy * 100).toFixed(1)}%  (threshold: ${CLASS_ACCURACY_THRESHOLD * 100}%)`);
  console.log(`Refusal precision:    ${(s.refusalPrecision * 100).toFixed(1)}%`);
  console.log(`Citation precision:   ${(s.avgCitationPrecision * 100).toFixed(1)}%`);
  console.log(`Citation recall:      ${(s.avgCitationRecall * 100).toFixed(1)}%`);
  console.log(`Quality score:        ${(s.avgQualityScore * 100).toFixed(1)}%`);
  console.log(`Hallucination rate:   ${(s.hallucinationRate * 100).toFixed(2)}%  (threshold: ${HALLUCINATION_THRESHOLD * 100}%)`);
  console.log(`Avg latency:          ${s.avgLatencyMs.toFixed(0)}ms`);
  console.log(`\nResult: ${s.passed ? 'PASS ✓' : 'FAIL ✕'}\n`);
}

runEval().catch((err) => {
  console.error('Eval runner failed:', err);
  process.exit(1);
});

export { EvalResult, EvalSummary, GoldenFile, GoldenPair, computeCitationMetrics };
