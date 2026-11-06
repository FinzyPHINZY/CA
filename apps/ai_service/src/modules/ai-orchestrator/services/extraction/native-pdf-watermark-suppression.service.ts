import { Injectable } from '@nestjs/common';
import { ExtractedBlock } from './document-extraction.types';

export interface NativePdfWatermarkSuppressionResult {
  blocks: ExtractedBlock[];
  watermarkDetected: boolean;
  removedHeaderFooterCount: number;
  removedWatermarkCount: number;
  watermarkTexts: string[];
  warnings: string[];
}

@Injectable()
export class NativePdfWatermarkSuppressionService {
  private readonly headerZoneBottom = 60;
  private readonly footerZoneTop = 730;
  private readonly middleZoneTop = 120;
  private readonly middleZoneBottom = 680;
  private readonly sceneHeadingRegex = /^(INT|EXT|INT\/EXT|EXT\/INT|I\/E)\.?/i;
  private readonly watermarkKeywords = [
    'confidential',
    'property of',
    'for your consideration',
    'do not distribute',
    'screener',
    'draft',
    'internal use',
    'not for sale',
    'awards consideration',
  ];

  suppress(blocks: ExtractedBlock[]): NativePdfWatermarkSuppressionResult {
    if (!blocks.length) {
      return {
        blocks,
        watermarkDetected: false,
        removedHeaderFooterCount: 0,
        removedWatermarkCount: 0,
        watermarkTexts: [],
        warnings: [],
      };
    }

    const repeatedKeys = this.collectRepeatedKeys(blocks);
    let removedHeaderFooterCount = 0;
    let removedWatermarkCount = 0;
    const watermarkTexts = new Set<string>();

    const filteredBlocks = blocks.filter((block) => {
      const position = this.getPagePosition(block);
      const normalized = this.normalizeText(block.text);
      const repeated = repeatedKeys.get(normalized);
      const rotation = Math.abs(Number(block.attributes?.rotationDegrees || 0));
      const fontSize = Number(block.attributes?.fontSize || 0);
      const inHeader = position.inHeader;
      const inFooter = position.inFooter;
      const inMiddle = position.inMiddle;
      const keywordHit = this.watermarkKeywords.some((keyword) =>
        normalized.includes(keyword),
      );
      const protectedContent = this.looksLikeProtectedScreenplayContent(block);

      if (
        !protectedContent &&
        (inHeader || inFooter) &&
        !inMiddle &&
        (repeated?.ratio || 0) >= 0.3
      ) {
        removedHeaderFooterCount += 1;
        watermarkTexts.add(block.text);
        return false;
      }

      if (
        !protectedContent &&
        ((rotation > 5 && inMiddle) ||
          ((repeated?.ratio || 0) >= 0.2 &&
            inMiddle &&
            (keywordHit ||
              fontSize >= 20 ||
              this.looksNoisy(block.text) ||
              Boolean(repeated?.centerWeighted))))
      ) {
        removedWatermarkCount += 1;
        watermarkTexts.add(block.text);
        return false;
      }

      return true;
    });

    const warnings: string[] = [];
    if (removedHeaderFooterCount > 0) {
      warnings.push(
        `Removed ${removedHeaderFooterCount} recurring header/footer native text blocks.`,
      );
    }
    if (removedWatermarkCount > 0) {
      warnings.push(
        `Removed ${removedWatermarkCount} native text blocks suspected to be watermarks or tracking overlays.`,
      );
    }

    return {
      blocks: filteredBlocks,
      watermarkDetected:
        removedHeaderFooterCount > 0 || removedWatermarkCount > 0,
      removedHeaderFooterCount,
      removedWatermarkCount,
      watermarkTexts: Array.from(watermarkTexts).sort(),
      warnings,
    };
  }

  private collectRepeatedKeys(
    blocks: ExtractedBlock[],
  ): Map<string, { ratio: number; centerWeighted: boolean }> {
    const totalPages = new Set(blocks.map((block) => block.page)).size || 1;
    const pageHits = new Map<string, Set<number>>();
    const centerFlags = new Map<string, boolean>();

    for (const block of blocks) {
      const normalized = this.normalizeText(block.text);
      if (!normalized || normalized.length > 80) continue;
      if (this.looksLikeProtectedScreenplayContent(block)) continue;
      const position = this.getPagePosition(block);
      if (!pageHits.has(normalized)) {
        pageHits.set(normalized, new Set<number>());
      }
      pageHits.get(normalized)?.add(block.page);
      if (position.inMiddle) {
        centerFlags.set(normalized, true);
      }
    }

    const result = new Map<
      string,
      { ratio: number; centerWeighted: boolean }
    >();
    for (const [key, pages] of pageHits.entries()) {
      result.set(key, {
        ratio: pages.size / totalPages,
        centerWeighted: centerFlags.get(key) || false,
      });
    }
    return result;
  }

  private looksLikeProtectedScreenplayContent(block: ExtractedBlock): boolean {
    const text = block.text.trim();
    const normalized = this.normalizeText(text);
    const left = this.getLeft(block.boundingBox);
    const width = this.getWidth(block.boundingBox);

    if (this.sceneHeadingRegex.test(text)) {
      return true;
    }

    if (
      text === text.toUpperCase() &&
      /^[A-Z][A-Z0-9 .'\-()]{1,29}$/.test(text) &&
      !/^\d+$/.test(text) &&
      left >= 180 &&
      left <= 320 &&
      !this.watermarkKeywords.some((keyword) => normalized.includes(keyword)) &&
      !this.looksNoisy(text)
    ) {
      return true;
    }

    if (text.startsWith('(') && text.endsWith(')')) {
      return true;
    }

    if (
      left >= 180 &&
      left <= 360 &&
      width <= 360 &&
      text.length >= 8 &&
      !this.looksNoisy(text)
    ) {
      return true;
    }

    return false;
  }

  private looksNoisy(text: string): boolean {
    const normalized = this.normalizeText(text);
    const letters = (normalized.match(/[a-z]/g) || []).length;
    const digits = (normalized.match(/\d/g) || []).length;
    const punctuation = (text.match(/[^a-z0-9\s]/gi) || []).length;
    return (
      digits >= letters ||
      punctuation > letters ||
      /^[\d\s:/.\-]+$/i.test(text) ||
      this.watermarkKeywords.some((keyword) => normalized.includes(keyword))
    );
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private getPagePosition(block: ExtractedBlock) {
    const top = this.getTop(block.boundingBox);
    const bottom = this.getBottom(block.boundingBox);
    const center = (top + bottom) / 2;
    return {
      top,
      bottom,
      center,
      inHeader: top <= this.headerZoneBottom,
      inFooter: bottom >= this.footerZoneTop,
      inMiddle: top >= this.middleZoneTop && bottom <= this.middleZoneBottom,
    };
  }

  private getTop(bounds?: number[]): number {
    if (!bounds || bounds.length < 2) return 0;
    const ys = bounds.filter((_, idx) => idx % 2 === 1);
    return Math.min(...ys);
  }

  private getBottom(bounds?: number[]): number {
    if (!bounds || bounds.length < 2) return 0;
    const ys = bounds.filter((_, idx) => idx % 2 === 1);
    return Math.max(...ys);
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
}
