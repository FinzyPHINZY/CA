import { Injectable, Logger } from '@nestjs/common';
import { ExtractedBlock } from './document-extraction.types';
import { FdxParseResult, FdxScene } from '../fdx-parser.service';
import {
  ColumnCalibration,
  DEFAULT_COLUMN_CALIBRATION,
  ElementType,
  buildSceneHeadingRegex,
  classifyElementByPosition,
  isAllCaps,
} from '../screenplay-normalizer.utils';

interface NormalizedLine {
  page: number;
  top: number;
  bottom: number;
  left: number;
  width: number;
  text: string;
}

interface ClassifiedLine {
  line: NormalizedLine;
  elementType: ElementType;
}

type PageStats = {
  minTop: number;
  maxBottom: number;
};

export interface StructuredNormalizationResult {
  fdxResult: FdxParseResult;
  warnings: string[];
  coverageRatio: number;
  parsedPages: number[];
  structuralFlags?: Record<string, any>;
  pagesParsedRatio?: number;
}

@Injectable()
export class StructuredExtractionNormalizer {
  private readonly logger = new Logger(StructuredExtractionNormalizer.name);

  normalizeToPlainText(blocks: ExtractedBlock[]): string {
    const lines = this.groupIntoLines(blocks);
    return lines.map((line) => line.text).join('\n');
  }

  normalizeToFdx(
    blocks: ExtractedBlock[],
  ): StructuredNormalizationResult | null {
    if (!blocks.length) {
      return null;
    }

    const lines = this.groupIntoLines(blocks);
    const noiseResult = this.removeStructuralNoise(lines);
    const warnings: string[] = [...noiseResult.warnings];
    const filteredLines = noiseResult.lines;
    const sceneHeadingRegex = buildSceneHeadingRegex();
    const columnCalibration = this.calibrateColumnPositions(
      filteredLines,
      sceneHeadingRegex,
    );
    const classifiedLines = this.recoverDialogueContinuations(
      filteredLines.map((line) => ({
        line,
        elementType: classifyElementByPosition(line, columnCalibration),
      })),
    );
    const scenes: FdxScene[] = [];
    const characterSet = new Set<string>();
    const rawTextParts: string[] = [];
    const parsedPages = Array.from(new Set(blocks.map((b) => b.page))).sort(
      (a, b) => a - b,
    );
    const totalPages = Math.max(...parsedPages, 1);
    const coverageRatio = parsedPages.length / totalPages;

    let currentScene: FdxScene | null = null;
    let currentSpeaker: string | null = null;
    let sceneNumber = 0;
    let dialogueCount = 0;

    for (const classifiedLine of classifiedLines) {
      const { line, elementType } = classifiedLine;
      const trimmed = line.text.trim();
      if (!trimmed) continue;
      rawTextParts.push(trimmed);

      switch (elementType) {
        case ElementType.SCENE_HEADING: {
          sceneNumber += 1;
          currentScene = {
            number: sceneNumber,
            heading: trimmed,
            elements: [],
            characters: [],
            page: line.page,
            pages: line.page ? [line.page] : [],
          };
          scenes.push(currentScene);
          currentSpeaker = null;
          if (!sceneHeadingRegex.test(trimmed)) {
            warnings.push(
              `Scene heading #${sceneNumber} does not start with INT./EXT.: "${trimmed}"`,
            );
          }
          break;
        }

        case ElementType.CHARACTER: {
          const name = trimmed.replace(/\s*\(.*\)\s*$/, '').trim();
          if (!name) break;
          const upper = name.toUpperCase();
          currentSpeaker = upper;
          characterSet.add(upper);
          if (currentScene && !currentScene.characters.includes(upper)) {
            currentScene.characters.push(upper);
          }
          break;
        }

        case ElementType.DIALOGUE: {
          if (!currentScene) {
            currentScene = this.createImplicitScene(
              ++sceneNumber,
              scenes,
              line.page,
            );
          }
          currentScene.elements.push({
            type: 'dialogue',
            characterName: currentSpeaker,
            lines: [trimmed],
            page: line.page,
          });
          this.trackScenePage(currentScene, line.page);
          if (currentSpeaker) {
            characterSet.add(currentSpeaker);
          }
          dialogueCount += 1;
          break;
        }

        case ElementType.PARENTHETICAL: {
          if (!currentScene) {
            currentScene = this.createImplicitScene(
              ++sceneNumber,
              scenes,
              line.page,
            );
          }
          currentScene.elements.push({
            type: 'parenthetical',
            characterName: currentSpeaker,
            lines: [trimmed],
            page: line.page,
          });
          this.trackScenePage(currentScene, line.page);
          break;
        }

        default: {
          if (!currentScene) {
            currentScene = this.createImplicitScene(
              ++sceneNumber,
              scenes,
              line.page,
            );
          }
          currentScene.elements.push({
            type: 'action',
            characterName: null,
            lines: [trimmed],
            page: line.page,
          });
          this.trackScenePage(currentScene, line.page);
          break;
        }
      }
    }

    if (scenes.length === 0 && rawTextParts.length > 0) {
      warnings.push(
        'No scene headings detected. Creating a single fallback scene.',
      );
      const fallbackScene: FdxScene = {
        number: 1,
        heading: 'SCENE 1',
        elements: rawTextParts.map((text) => ({
          type: 'action',
          characterName: null,
          lines: [text],
          page: parsedPages[0] ?? 1,
        })),
        characters: Array.from(characterSet),
        page: parsedPages[0] ?? 1,
        pages: parsedPages.length ? parsedPages : [parsedPages[0] ?? 1],
      };
      scenes.push(fallbackScene);
    }

    if (coverageRatio < 0.9) {
      warnings.push(
        `Only ${(coverageRatio * 100).toFixed(0)}% of pages contained extractor blocks.`,
      );
    }
    if (dialogueCount === 0) {
      warnings.push(
        'No dialogue blocks detected. Script may be action-only or extraction failed to detect characters.',
      );
    }

    const rawText = filteredLines.map((line) => line.text).join('\n');

    if (
      (noiseResult.removedHeaderFooterCount || 0) >
      Math.max(10, lines.length * 0.25)
    ) {
      warnings.push(
        'Unusually high number of header/footer lines removed. Please verify extraction quality.',
      );
    }
    if ((noiseResult.removedWatermarkCount || 0) > 10) {
      warnings.push(
        'Significant watermark-like content removed. Script may contain heavy tracking codes.',
      );
    }
    const dualColumnDetected = this.detectDualColumnLayout(filteredLines);
    if (dualColumnDetected) {
      warnings.push(
        'Possible dual-column screenplay layout detected; some dialogue classification may require review.',
      );
    }

    const structuralFlags: Record<string, any> = {
      dualColumnDetected,
      removedHeadersOrFooters: noiseResult.removedHeaderFooterCount ?? 0,
      removedWatermarks: noiseResult.removedWatermarkCount ?? 0,
      columnCalibration,
    };

    const fdxResult: FdxParseResult = {
      title: null,
      scenes,
      characters: Array.from(characterSet),
      rawText,
    };

    return {
      fdxResult,
      warnings,
      coverageRatio,
      parsedPages,
      structuralFlags,
      pagesParsedRatio: coverageRatio,
    };
  }

  private createImplicitScene(
    sceneNumber: number,
    scenes: FdxScene[],
    page?: number,
  ): FdxScene {
    const scene: FdxScene = {
      number: sceneNumber,
      heading: `SCENE ${sceneNumber}`,
      elements: [],
      characters: [],
      page,
      pages: page ? [page] : [],
    };
    scenes.push(scene);
    return scene;
  }

  private trackScenePage(scene: FdxScene, page?: number) {
    if (!scene || !page) {
      return;
    }
    if (!scene.pages) {
      scene.pages = [];
    }
    if (!scene.pages.includes(page)) {
      scene.pages.push(page);
      scene.pages.sort((a, b) => a - b);
    }
    if (!scene.page || page < scene.page) {
      scene.page = page;
    }
  }

  private recoverDialogueContinuations(
    classifiedLines: ClassifiedLine[],
  ): ClassifiedLine[] {
    let currentSpeakerActive = false;
    let previousDialogueLine: NormalizedLine | null = null;
    let recentSpeakerCueIndex: number | null = null;

    return classifiedLines.map((classifiedLine, index) => {
      let { elementType } = classifiedLine;
      const { line } = classifiedLine;
      const trimmed = line.text.trim();
      const nextClassifiedLine = classifiedLines[index + 1];

      if (
        elementType === ElementType.ACTION &&
        this.looksLikeRecoveredCharacterCue(trimmed, nextClassifiedLine)
      ) {
        elementType = ElementType.CHARACTER;
      }

      if (elementType === ElementType.SCENE_HEADING) {
        currentSpeakerActive = false;
        previousDialogueLine = null;
        recentSpeakerCueIndex = null;
        return { ...classifiedLine, elementType };
      }

      if (elementType === ElementType.CHARACTER) {
        currentSpeakerActive = true;
        previousDialogueLine = null;
        recentSpeakerCueIndex = index;
        return { ...classifiedLine, elementType };
      }

      if (elementType === ElementType.PARENTHETICAL) {
        if (currentSpeakerActive) {
          previousDialogueLine = null;
        }
        return { ...classifiedLine, elementType };
      }

      if (elementType === ElementType.DIALOGUE) {
        currentSpeakerActive = true;
        previousDialogueLine = line;
        return { ...classifiedLine, elementType };
      }

      if (elementType === ElementType.TRANSITION) {
        currentSpeakerActive = false;
        previousDialogueLine = null;
        recentSpeakerCueIndex = null;
        return { ...classifiedLine, elementType };
      }

      if (
        elementType === ElementType.ACTION &&
        ((currentSpeakerActive &&
          this.looksLikeDialogueContinuation(
            line,
            previousDialogueLine,
            nextClassifiedLine,
          )) ||
          this.shouldPromoteActionToDialogue(
            line,
            index,
            recentSpeakerCueIndex,
            nextClassifiedLine,
          ))
      ) {
        currentSpeakerActive = true;
        previousDialogueLine = line;
        return {
          ...classifiedLine,
          elementType: ElementType.DIALOGUE,
        };
      }

      if (elementType === ElementType.ACTION) {
        if (!this.looksLikeSpokenLine(trimmed)) {
          currentSpeakerActive = false;
          previousDialogueLine = null;
          recentSpeakerCueIndex = null;
        }
      }

      return { ...classifiedLine, elementType };
    });
  }

  private shouldPromoteActionToDialogue(
    line: NormalizedLine,
    index: number,
    recentSpeakerCueIndex: number | null,
    nextClassifiedLine?: ClassifiedLine,
  ): boolean {
    if (recentSpeakerCueIndex === null) {
      return false;
    }

    if (index - recentSpeakerCueIndex > 3) {
      return false;
    }

    const trimmed = line.text.trim();
    if (!this.looksLikeSpokenLine(trimmed)) {
      return false;
    }

    if (this.isLikelyStageDirection(trimmed)) {
      return false;
    }

    if (nextClassifiedLine?.elementType === ElementType.CHARACTER) {
      return true;
    }

    return this.looksLikeDialogueContinuation(line, null, nextClassifiedLine);
  }

  private groupIntoLines(blocks: ExtractedBlock[]): NormalizedLine[] {
    if (!blocks.length) return [];
    const tolerance = 4;
    const grouped: Array<{
      page: number;
      yKey: number;
      blocks: ExtractedBlock[];
    }> = [];

    const sorted = [...blocks].sort((a, b) => {
      if (a.page === b.page) {
        const topDiff = this.getTop(a.boundingBox) - this.getTop(b.boundingBox);
        if (Math.abs(topDiff) < tolerance) {
          return this.getLeft(a.boundingBox) - this.getLeft(b.boundingBox);
        }
        return topDiff;
      }
      return a.page - b.page;
    });

    for (const block of sorted) {
      const top = this.getTop(block.boundingBox);
      const yKey = Math.round(top / tolerance);
      let line = grouped.find((g) => g.page === block.page && g.yKey === yKey);
      if (!line) {
        line = { page: block.page, yKey, blocks: [] };
        grouped.push(line);
      }
      line.blocks.push(block);
    }

    return grouped
      .sort((a, b) => {
        if (a.page === b.page) {
          return a.yKey - b.yKey;
        }
        return a.page - b.page;
      })
      .map((group) => {
        const orderedBlocks = group.blocks.sort(
          (a, b) => this.getLeft(a.boundingBox) - this.getLeft(b.boundingBox),
        );
        const text = orderedBlocks
          .map((blk) => blk.text.trim())
          .filter((txt) => txt.length > 0)
          .join(' ')
          .trim();
        const left = this.getLeft(orderedBlocks[0]?.boundingBox);
        const top = this.getTop(orderedBlocks[0]?.boundingBox);
        const bottom = Math.max(
          ...orderedBlocks.map((blk) => this.getBottom(blk.boundingBox)),
        );
        const right =
          this.getLeft(orderedBlocks[orderedBlocks.length - 1]?.boundingBox) +
          this.getWidth(orderedBlocks[orderedBlocks.length - 1]?.boundingBox);
        return {
          page: group.page,
          top,
          bottom,
          left,
          width: right - left,
          text,
        };
      })
      .filter((line) => line.text.length > 0);
  }

  private getTop(bounds?: number[]): number {
    if (!bounds || bounds.length < 2) return 0;
    const ys = bounds.filter((_, idx) => idx % 2 === 1);
    return Math.min(...ys);
  }

  private getLeft(bounds?: number[]): number {
    if (!bounds || bounds.length < 2) return 0;
    const xs = bounds.filter((_, idx) => idx % 2 === 0);
    return Math.min(...xs);
  }

  private getWidth(bounds?: number[]): number {
    if (!bounds || bounds.length < 2) return 0;
    const xs = bounds.filter((_, idx) => idx % 2 === 0);
    return Math.max(...xs) - Math.min(...xs);
  }

  private getBottom(bounds?: number[]): number {
    if (!bounds || bounds.length < 2) return 0;
    const ys = bounds.filter((_, idx) => idx % 2 === 1);
    return Math.max(...ys);
  }

  private removeStructuralNoise(lines: NormalizedLine[]): {
    lines: NormalizedLine[];
    warnings: string[];
    removedHeaderFooterCount: number;
    removedWatermarkCount: number;
  } {
    if (!lines.length) {
      return {
        lines,
        warnings: [],
        removedHeaderFooterCount: 0,
        removedWatermarkCount: 0,
      };
    }

    const pageStats = this.buildPageStats(lines);
    const totalPages = pageStats.size || 1;
    const headerKeys = this.collectRecurringKeys(lines, pageStats, {
      band: 'header',
      ratio: 0.3,
      stripDigits: true,
    });
    const footerKeys = this.collectRecurringKeys(lines, pageStats, {
      band: 'footer',
      ratio: 0.3,
      stripDigits: true,
    });
    const watermarkKeys = this.collectRecurringKeys(lines, pageStats, {
      band: 'middle',
      ratio: 0.2,
      stripDigits: false,
      filter: (line, relPos) =>
        this.looksLikeWatermark(line.text) &&
        relPos.center > 0.2 &&
        relPos.center < 0.8,
    });

    const HEADER_BAND = 0.12;
    const FOOTER_BAND = 0.88;

    let headerRemoved = 0;
    let footerRemoved = 0;
    let watermarkRemoved = 0;

    const filtered = lines.filter((line) => {
      const stats = pageStats.get(line.page);
      if (!stats) return true;
      const relPos = this.getRelativePosition(line, stats);
      const headerCandidate = relPos.top <= HEADER_BAND;
      const footerCandidate = relPos.bottom >= FOOTER_BAND;
      const normalizedKey = this.buildStructuralKey(line.text, true);

      if (headerCandidate && headerKeys.has(normalizedKey)) {
        headerRemoved += 1;
        return false;
      }

      if (
        footerCandidate &&
        (footerKeys.has(normalizedKey) ||
          this.isLikelyPageNumber(line.text, totalPages))
      ) {
        footerRemoved += 1;
        return false;
      }

      if (
        watermarkKeys.has(this.buildStructuralKey(line.text, false)) &&
        relPos.center > 0.2 &&
        relPos.center < 0.8
      ) {
        watermarkRemoved += 1;
        return false;
      }

      return true;
    });

    const warnings: string[] = [];
    if (headerRemoved > 0 || footerRemoved > 0) {
      warnings.push(
        `Removed ${headerRemoved + footerRemoved} recurring header/footer lines.`,
      );
    }
    if (watermarkRemoved > 0) {
      warnings.push(
        `Removed ${watermarkRemoved} lines suspected to be watermarks or tracking codes.`,
      );
    }

    return {
      lines: filtered,
      warnings,
      removedHeaderFooterCount: headerRemoved + footerRemoved,
      removedWatermarkCount: watermarkRemoved,
    };
  }

  private calibrateColumnPositions(
    lines: NormalizedLine[],
    sceneHeadingRegex: RegExp,
  ): ColumnCalibration {
    if (!lines.length) {
      return DEFAULT_COLUMN_CALIBRATION;
    }

    const headingLefts = lines
      .filter((line) => sceneHeadingRegex.test(line.text.trim()))
      .map((line) => line.left);
    const characterLefts = lines
      .filter((line) => this.isCharacterCandidate(line.text))
      .map((line) => line.left);
    const parentheticalLefts = lines
      .filter((line) => this.isParentheticalCandidate(line.text))
      .map((line) => line.left);
    const dialogueCandidates = lines.filter((line) =>
      this.isDialogueCandidate(line),
    );
    const dialogueLefts = dialogueCandidates.map((line) => line.left);
    const dialogueWidths = dialogueCandidates.map((line) => line.width);
    const transitionLefts = lines
      .filter((line) => this.isTransitionCandidate(line.text))
      .map((line) => line.left);

    const characterLeft = this.median(characterLefts) ?? 240;
    const actionLefts = lines
      .filter(
        (line) =>
          !this.isCharacterCandidate(line.text) &&
          !this.isParentheticalCandidate(line.text) &&
          !this.isTransitionCandidate(line.text) &&
          line.left < characterLeft,
      )
      .map((line) => line.left);

    const parentheticalLeft =
      this.median(parentheticalLefts) ?? characterLeft + 5;
    const dialogueLeft =
      this.median(dialogueLefts) ?? Math.max(characterLeft + 20, 260);
    const dialogueWidthMax = this.median(dialogueWidths) ?? 320;
    const transitionMinLeft =
      this.median(transitionLefts) ??
      Math.max(
        dialogueLeft + 160,
        DEFAULT_COLUMN_CALIBRATION.transitionMinLeft,
      );
    const actionMaxLeft =
      this.median(actionLefts) ??
      Math.min(characterLeft - 20, DEFAULT_COLUMN_CALIBRATION.actionMaxLeft);
    const headingMaxLeft =
      this.median(headingLefts) ?? DEFAULT_COLUMN_CALIBRATION.headingMaxLeft;

    return {
      headingMaxLeft,
      characterLeft,
      characterTolerance: DEFAULT_COLUMN_CALIBRATION.characterTolerance,
      dialogueLeft,
      dialogueWidthMax,
      parentheticalLeft,
      transitionMinLeft,
      actionMaxLeft,
    };
  }

  private buildPageStats(lines: NormalizedLine[]): Map<number, PageStats> {
    const pageStats = new Map<number, PageStats>();
    for (const line of lines) {
      const stats = pageStats.get(line.page) ?? {
        minTop: line.top,
        maxBottom: line.bottom,
      };
      stats.minTop = Math.min(stats.minTop, line.top);
      stats.maxBottom = Math.max(stats.maxBottom, line.bottom);
      pageStats.set(line.page, stats);
    }
    return pageStats;
  }

  private looksLikeDialogueContinuation(
    line: NormalizedLine,
    previousDialogueLine: NormalizedLine | null,
    nextClassifiedLine?: ClassifiedLine,
  ): boolean {
    const trimmed = line.text.trim();
    if (!trimmed) {
      return false;
    }

    if (
      this.isCharacterCandidate(trimmed) ||
      this.isTransitionCandidate(trimmed) ||
      this.isParentheticalCandidate(trimmed) ||
      buildSceneHeadingRegex().test(trimmed)
    ) {
      return false;
    }

    const nextType = nextClassifiedLine?.elementType;
    const nextLine = nextClassifiedLine?.line;
    const nextLooksRelated =
      nextType === ElementType.DIALOGUE ||
      nextType === ElementType.PARENTHETICAL ||
      (nextType === ElementType.ACTION &&
        nextLine &&
        nextLine.page === line.page &&
        Math.abs(nextLine.top - line.bottom) <= 18);

    if (previousDialogueLine) {
      const samePage = previousDialogueLine.page === line.page;
      const closeVertically =
        Math.abs(line.top - previousDialogueLine.bottom) <= 24;
      const indentationDrift =
        Math.abs(line.left - previousDialogueLine.left) <= 120;
      if (samePage && closeVertically && indentationDrift) {
        return true;
      }
    }

    const endsLikeContinuation = !/[.!?:"'][-"']?$/.test(trimmed);
    return endsLikeContinuation && Boolean(nextLooksRelated);
  }

  private looksLikeRecoveredCharacterCue(
    text: string,
    nextClassifiedLine?: ClassifiedLine,
  ): boolean {
    if (!this.isCharacterCandidate(text)) {
      return false;
    }

    if (!nextClassifiedLine) {
      return false;
    }

    if (nextClassifiedLine.elementType === ElementType.PARENTHETICAL) {
      return true;
    }

    return this.looksLikeSpokenLine(nextClassifiedLine.line.text.trim());
  }

  private looksLikeSpokenLine(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > 120) {
      return false;
    }
    if (this.isCharacterCandidate(trimmed)) {
      return false;
    }
    if (this.isParentheticalCandidate(trimmed)) {
      return false;
    }
    if (this.isTransitionCandidate(trimmed)) {
      return false;
    }
    if (buildSceneHeadingRegex().test(trimmed)) {
      return false;
    }
    if (/:$/.test(trimmed)) {
      return false;
    }
    if (/[?!]$/.test(trimmed)) {
      return true;
    }
    const wordCount = trimmed.split(/\s+/).length;
    return wordCount <= 14;
  }

  private isLikelyStageDirection(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (/^(FADE|CUT|DISSOLVE|SMASH CUT|MATCH CUT)\b/i.test(trimmed)) {
      return true;
    }
    if (/^(START|END|BEGIN|CONTINUED)\b/i.test(trimmed)) {
      return true;
    }
    return /^[A-Z][A-Z\s-]{0,20}$/.test(trimmed);
  }

  private collectRecurringKeys(
    lines: NormalizedLine[],
    pageStats: Map<number, PageStats>,
    options: {
      band: 'header' | 'footer' | 'middle';
      ratio: number;
      stripDigits: boolean;
      filter?: (
        line: NormalizedLine,
        relativePosition: { top: number; bottom: number; center: number },
      ) => boolean;
    },
  ): Set<string> {
    const counts = new Map<string, number>();
    const totalPages = pageStats.size || 1;
    const headerBand = 0.12;
    const footerBand = 0.88;

    for (const line of lines) {
      const stats = pageStats.get(line.page);
      if (!stats) continue;
      const relPos = this.getRelativePosition(line, stats);
      let inBand = false;

      if (options.band === 'header') {
        inBand = relPos.top <= headerBand;
      } else if (options.band === 'footer') {
        inBand = relPos.bottom >= footerBand;
      } else {
        inBand = relPos.center > headerBand && relPos.center < footerBand;
      }

      if (!inBand) continue;
      if (options.filter && !options.filter(line, relPos)) continue;

      const key = this.buildStructuralKey(line.text, options.stripDigits);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const threshold = Math.max(1, Math.floor(totalPages * options.ratio));
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count >= threshold)
        .map(([key]) => key),
    );
  }

  private getRelativePosition(
    line: NormalizedLine,
    stats: PageStats,
  ): { top: number; bottom: number; center: number } {
    const height = Math.max(stats.maxBottom - stats.minTop, 1);
    const top = (line.top - stats.minTop) / height;
    const bottom = (line.bottom - stats.minTop) / height;
    return {
      top,
      bottom,
      center: (top + bottom) / 2,
    };
  }

  private buildStructuralKey(text: string, stripDigits: boolean): string {
    let cleaned = text.replace(/\s+/g, ' ').trim().toUpperCase();
    if (!cleaned) return '';
    if (stripDigits) {
      cleaned = cleaned.replace(/\d+/g, '#');
    }
    return cleaned;
  }

  private isLikelyPageNumber(text: string, totalPages: number): boolean {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return false;
    if (/^page\s+\d+$/i.test(trimmed)) return true;
    if (/^\d+$/.test(trimmed)) {
      const value = Number(trimmed);
      return value > 0 && value <= totalPages + 5;
    }
    if (/^\d+\s*\/\s*\d+$/.test(trimmed)) return true;
    return false;
  }

  private looksLikeWatermark(text: string): boolean {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return false;
    if (trimmed.length < 6) return false;
    const digitCount = (trimmed.match(/\d/g) || []).length;
    const letterCount = (trimmed.match(/[A-Z]/gi) || []).length;
    if (digitCount > 0 && letterCount > 0 && /[-:]/.test(trimmed)) {
      return true;
    }
    if (/([A-Z0-9]{3,}\s*-\s*){2,}/i.test(trimmed)) {
      return true;
    }
    return false;
  }

  private isCharacterCandidate(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length > 0 && trimmed.length <= 30 && isAllCaps(trimmed);
  }

  private isParentheticalCandidate(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('(') && trimmed.endsWith(')');
  }

  private isTransitionCandidate(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.endsWith('TO:') && isAllCaps(trimmed);
  }

  private isDialogueCandidate(line: NormalizedLine): boolean {
    const trimmed = line.text.trim();
    if (!trimmed) return false;
    if (this.isCharacterCandidate(trimmed)) return false;
    if (this.isParentheticalCandidate(trimmed)) return false;
    if (line.width > 520 || line.width < 50) return false;
    return true;
  }

  private detectDualColumnLayout(lines: NormalizedLine[]): boolean {
    if (lines.length < 60) {
      return false;
    }
    const lefts = lines
      .map((line) => line.left)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (lefts.length < 60) {
      return false;
    }

    const clusters: number[][] = [];
    let currentCluster: number[] = [];
    const clusterGap = 100;

    for (let i = 0; i < lefts.length; i += 1) {
      const value = lefts[i];
      if (
        currentCluster.length &&
        Math.abs(value - currentCluster[currentCluster.length - 1]) > clusterGap
      ) {
        clusters.push(currentCluster);
        currentCluster = [];
      }
      currentCluster.push(value);
    }
    if (currentCluster.length) {
      clusters.push(currentCluster);
    }

    const meaningfulClusters = clusters.filter(
      (cluster) => cluster.length >= lines.length * 0.15,
    );
    if (meaningfulClusters.length < 2) {
      return false;
    }

    const centers = meaningfulClusters.map(
      (cluster) =>
        cluster.reduce((sum, value) => sum + value, 0) / cluster.length,
    );
    centers.sort((a, b) => a - b);
    const largestGap = centers[centers.length - 1] - centers[0];
    return largestGap >= 150;
  }

  private median(values: number[]): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }
}
