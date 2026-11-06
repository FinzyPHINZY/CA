import { Injectable, Logger } from '@nestjs/common';
import * as pdfParse from 'pdf-parse';

export type NativePdfCapabilityStrength = 'strong' | 'weak' | 'absent';
export type NativePdfRecommendedPath = 'native_text' | 'ocr_fallback';

export interface NativePdfCapabilitySignals {
  sampledPages: number;
  pageCount: number | null;
  textCharCount: number;
  nonEmptyLineCount: number;
  avgCharsPerPage: number | null;
  screenplaySignalScore: number;
  noiseSignalScore: number;
  layoutCoherenceScore: number;
  sceneHeadingMatches: number;
  characterCueMatches: number;
  dialogueLikeLines: number;
  repeatedNoiseLineCount: number;
  watermarkKeywordHits: number;
}

export interface NativePdfCapabilityResult {
  nativeTextLayerDetected: boolean;
  nativeTextLayerStrength: NativePdfCapabilityStrength;
  recommendedPath: NativePdfRecommendedPath;
  reasons: string[];
  signals: NativePdfCapabilitySignals;
  evaluatedAt: string;
}

@Injectable()
export class NativePdfCapabilityDetectorService {
  private readonly logger = new Logger(NativePdfCapabilityDetectorService.name);
  private readonly sceneHeadingRegex = /^(INT|EXT|INT\/EXT|EXT\/INT|I\/E)\.?/i;
  private readonly characterCueRegex =
    /^(?!INT\.?$|EXT\.?$)(?=.*[A-Z])[A-Z][A-Z0-9 .'\-()]{1,29}$/;
  private readonly watermarkKeywords = [
    'confidential',
    'property of',
    'for your consideration',
    'do not distribute',
    'screener',
    'draft',
    'internal use',
  ];

  async detect(
    buffer: Buffer,
    fileName?: string | null,
  ): Promise<NativePdfCapabilityResult> {
    try {
      const parsed = await pdfParse(buffer);
      const rawText = typeof parsed?.text === 'string' ? parsed.text : '';
      const pageCount =
        typeof parsed?.numpages === 'number' && parsed.numpages > 0
          ? parsed.numpages
          : null;
      return this.detectFromText(rawText, {
        pageCount,
        fileName: fileName || null,
      });
    } catch (error: any) {
      const result: NativePdfCapabilityResult = {
        nativeTextLayerDetected: false,
        nativeTextLayerStrength: 'absent',
        recommendedPath: 'ocr_fallback',
        reasons: [
          `Native text-layer inspection failed: ${error?.message || 'unknown error'}.`,
        ],
        signals: {
          sampledPages: 0,
          pageCount: null,
          textCharCount: 0,
          nonEmptyLineCount: 0,
          avgCharsPerPage: null,
          screenplaySignalScore: 0,
          noiseSignalScore: 0,
          layoutCoherenceScore: 0,
          sceneHeadingMatches: 0,
          characterCueMatches: 0,
          dialogueLikeLines: 0,
          repeatedNoiseLineCount: 0,
          watermarkKeywordHits: 0,
        },
        evaluatedAt: new Date().toISOString(),
      };
      this.logger.warn(
        `[NativePdfCapability] Inspection failed for ${fileName || 'unknown'}: ${error?.message || 'unknown error'}`,
      );
      return result;
    }
  }

  detectFromText(
    rawText: string,
    options: { pageCount?: number | null; fileName?: string | null } = {},
  ): NativePdfCapabilityResult {
    const lines = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const textCharCount = rawText.replace(/\s+/g, '').length;
    const sceneHeadingMatches = lines.filter((line) =>
      this.sceneHeadingRegex.test(line),
    ).length;
    const characterCueMatches = lines.filter((line) =>
      this.isCharacterCue(line),
    ).length;
    const dialogueLikeLines = this.countDialogueLikeLines(lines);
    const repeatedNoiseLineCount = this.countRepeatedNoiseLines(lines);
    const watermarkKeywordHits = lines.filter((line) =>
      this.watermarkKeywords.some((keyword) =>
        line.toLowerCase().includes(keyword),
      ),
    ).length;
    const screenplaySignalScore = this.clamp01(
      Math.min(sceneHeadingMatches, 4) * 0.18 +
        Math.min(characterCueMatches, 8) * 0.07 +
        Math.min(dialogueLikeLines, 12) * 0.03,
    );
    const noiseSignalScore = this.clamp01(
      Math.min(repeatedNoiseLineCount, 10) * 0.08 +
        Math.min(watermarkKeywordHits, 6) * 0.1 +
        this.computeFragmentNoiseRatio(lines) * 0.5,
    );
    const layoutCoherenceScore = this.clamp01(
      this.computeStableLineRatio(lines) * 0.65 +
        this.computeDialogueFlowRatio(lines) * 0.35 -
        noiseSignalScore * 0.35,
    );
    const avgCharsPerPage =
      options.pageCount && options.pageCount > 0
        ? Number((textCharCount / options.pageCount).toFixed(2))
        : null;

    const signals: NativePdfCapabilitySignals = {
      sampledPages: options.pageCount ? Math.min(options.pageCount, 3) : 0,
      pageCount: options.pageCount ?? null,
      textCharCount,
      nonEmptyLineCount: lines.length,
      avgCharsPerPage,
      screenplaySignalScore: Number(screenplaySignalScore.toFixed(3)),
      noiseSignalScore: Number(noiseSignalScore.toFixed(3)),
      layoutCoherenceScore: Number(layoutCoherenceScore.toFixed(3)),
      sceneHeadingMatches,
      characterCueMatches,
      dialogueLikeLines,
      repeatedNoiseLineCount,
      watermarkKeywordHits,
    };

    const reasons: string[] = [];
    let nativeTextLayerDetected = true;
    let nativeTextLayerStrength: NativePdfCapabilityStrength = 'weak';
    let recommendedPath: NativePdfRecommendedPath = 'native_text';

    if (textCharCount < 80 || lines.length < 5) {
      nativeTextLayerDetected = false;
      nativeTextLayerStrength = 'absent';
      recommendedPath = 'ocr_fallback';
      reasons.push(
        'Native text-layer inspection recovered too little readable text for a confident digital-PDF path.',
      );
    } else if (screenplaySignalScore >= 0.5 && layoutCoherenceScore >= 0.45) {
      nativeTextLayerStrength = 'strong';
      reasons.push(
        'Native text layer contains strong screenplay signals and coherent line structure.',
      );
      if (noiseSignalScore >= 0.3) {
        reasons.push(
          'Watermark or repeated overlay noise is present, but the native text layer still looks usable.',
        );
      }
    } else {
      nativeTextLayerStrength = 'weak';
      reasons.push(
        'Native text layer is present, but screenplay or layout signals are mixed and may require fallback later.',
      );
      if (screenplaySignalScore < 0.25) {
        reasons.push(
          'Screenplay-specific cues are sparse in the native text layer.',
        );
      }
      if (layoutCoherenceScore < 0.35) {
        reasons.push(
          'Native text layout coherence appears weak or fragmented.',
        );
      }
      if (noiseSignalScore >= 0.3) {
        reasons.push(
          'Repeated noise or watermark-like text was detected in the native text layer.',
        );
      }
    }

    return {
      nativeTextLayerDetected,
      nativeTextLayerStrength,
      recommendedPath,
      reasons,
      signals,
      evaluatedAt: new Date().toISOString(),
    };
  }

  private isCharacterCue(line: string): boolean {
    return (
      this.characterCueRegex.test(line) &&
      !this.sceneHeadingRegex.test(line) &&
      /[A-Z]/.test(line) &&
      !/^\d+$/.test(line)
    );
  }

  private countDialogueLikeLines(lines: string[]): number {
    let count = 0;
    let speakerActive = false;

    for (const line of lines) {
      if (this.isCharacterCue(line)) {
        speakerActive = true;
        continue;
      }

      if (this.sceneHeadingRegex.test(line)) {
        speakerActive = false;
        continue;
      }

      if (
        speakerActive &&
        line.length >= 8 &&
        line.length <= 120 &&
        !this.isCharacterCue(line)
      ) {
        count += 1;
        continue;
      }

      speakerActive = false;
    }

    return count;
  }

  private countRepeatedNoiseLines(lines: string[]): number {
    const counts = new Map<string, number>();
    for (const line of lines) {
      const normalized = line.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 60) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }

    let repeatedNoiseLineCount = 0;
    for (const [line, count] of counts.entries()) {
      if (count < 3) continue;
      if (this.looksNoisy(line)) {
        repeatedNoiseLineCount += count;
      }
    }
    return repeatedNoiseLineCount;
  }

  private looksNoisy(line: string): boolean {
    const letters = (line.match(/[a-z]/gi) || []).length;
    const digits = (line.match(/\d/g) || []).length;
    const punctuation = (line.match(/[^a-z0-9\s]/gi) || []).length;
    const watermarkHit = this.watermarkKeywords.some((keyword) =>
      line.includes(keyword),
    );
    return (
      watermarkHit ||
      digits >= letters ||
      punctuation > letters ||
      /^[\d\s:/.-]+$/.test(line)
    );
  }

  private computeFragmentNoiseRatio(lines: string[]): number {
    if (!lines.length) return 0;
    const noisyLines = lines.filter((line) => {
      const letters = (line.match(/[a-z]/gi) || []).length;
      const digits = (line.match(/\d/g) || []).length;
      return line.length <= 5 || digits > letters * 1.5;
    }).length;
    return noisyLines / lines.length;
  }

  private computeStableLineRatio(lines: string[]): number {
    if (!lines.length) return 0;
    const stableLines = lines.filter((line) => {
      const letters = (line.match(/[a-z]/gi) || []).length;
      return line.length >= 3 && line.length <= 80 && letters >= 2;
    }).length;
    return stableLines / lines.length;
  }

  private computeDialogueFlowRatio(lines: string[]): number {
    if (!lines.length) return 0;
    const cueCount = lines.filter((line) => this.isCharacterCue(line)).length;
    if (cueCount === 0) return 0;
    return this.clamp01(this.countDialogueLikeLines(lines) / cueCount);
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}
