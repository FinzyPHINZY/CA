import { Injectable } from '@nestjs/common';
import { StructuredNormalizationResult } from './structured-extraction-normalizer.service';

export interface NativePdfQualityGateDecision {
  accepted: boolean;
  reasons: string[];
  metrics: {
    pageCount: number | null;
    coverageRatio: number;
    parsedPageCount: number;
    firstParsedPage: number | null;
    sceneCount: number;
    explicitSceneCount: number;
    dialogueBlockCount: number;
    characterCount: number;
  };
}

@Injectable()
export class NativePdfQualityGateService {
  evaluate(
    normalized: StructuredNormalizationResult | null,
    options: { pageCount?: number | null } = {},
  ): NativePdfQualityGateDecision {
    if (!normalized) {
      return {
        accepted: false,
        reasons: [
          'Native PDF extraction did not produce a structured normalization result.',
        ],
        metrics: {
          pageCount: options.pageCount ?? null,
          coverageRatio: 0,
          parsedPageCount: 0,
          firstParsedPage: null,
          sceneCount: 0,
          explicitSceneCount: 0,
          dialogueBlockCount: 0,
          characterCount: 0,
        },
      };
    }

    const sceneCount = normalized.fdxResult.scenes.length;
    const explicitSceneCount = normalized.fdxResult.scenes.filter(
      (scene) => !/^SCENE \d+$/i.test(scene.heading || ''),
    ).length;
    const dialogueBlockCount = normalized.fdxResult.scenes.reduce(
      (count, scene) =>
        count +
        scene.elements.filter((element) => element.type === 'dialogue').length,
      0,
    );
    const parsedPageCount = normalized.parsedPages.length;
    const firstParsedPage = normalized.parsedPages[0] ?? null;
    const characterCount = normalized.fdxResult.characters.length;
    const pageCount = options.pageCount ?? null;
    const reasons: string[] = [];

    if (normalized.coverageRatio < 0.75) {
      reasons.push(
        `Native PDF extraction coverage was too low (${normalized.coverageRatio.toFixed(2)}).`,
      );
    }

    if (sceneCount === 0) {
      reasons.push('Native PDF extraction recovered no scenes.');
    }

    if (explicitSceneCount === 0 && dialogueBlockCount === 0) {
      reasons.push(
        'Native PDF extraction recovered neither explicit scene headings nor dialogue blocks.',
      );
    }

    if (
      pageCount &&
      pageCount <= 3 &&
      firstParsedPage !== null &&
      firstParsedPage > 1
    ) {
      reasons.push(
        `Native PDF extraction missed the first content page on a short document (first parsed page ${firstParsedPage}).`,
      );
    }

    if (
      pageCount &&
      pageCount <= 3 &&
      dialogueBlockCount === 0 &&
      characterCount <= 1
    ) {
      reasons.push(
        'Native PDF extraction did not recover enough dialogue structure for a short side or packet.',
      );
    }

    if (
      normalized.warnings.some((warning) =>
        warning.includes('No dialogue blocks detected'),
      ) &&
      pageCount &&
      pageCount <= 3
    ) {
      reasons.push(
        'Native PDF extraction triggered a no-dialogue warning on a short document.',
      );
    }

    return {
      accepted: reasons.length === 0,
      reasons,
      metrics: {
        pageCount,
        coverageRatio: normalized.coverageRatio,
        parsedPageCount,
        firstParsedPage,
        sceneCount,
        explicitSceneCount,
        dialogueBlockCount,
        characterCount,
      },
    };
  }
}
