/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  Character,
  CharacterRepository,
  Scene,
  SceneRepository,
  Script,
  ScriptRepository,
  ScriptStatus,
} from '@app/common';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as pdfParse from 'pdf-parse';
import { firstValueFrom } from 'rxjs';
import { DataSource, EntityManager } from 'typeorm';
import {
  FdxParseResult,
  FdxParserService,
  FdxScene,
  FdxSceneElement,
} from './services/fdx-parser.service';
import { GeminiService, ScriptAnalysisResult } from './services/gemini.service';
import { AdobeExtractService } from './services/extraction/adobe-extract.service';
import {
  DocumentExtractionResult,
  ExtractedBlock,
} from './services/extraction/document-extraction.types';
import { DocumentAiExtractService } from './services/extraction/document-ai.service';
import { NativePdfExtractService } from './services/extraction/native-pdf-extract.service';
import { NativePdfWatermarkSuppressionService } from './services/extraction/native-pdf-watermark-suppression.service';
import { NativePdfQualityGateService } from './services/extraction/native-pdf-quality-gate.service';
import {
  StructuredExtractionNormalizer,
  StructuredNormalizationResult,
} from './services/extraction/structured-extraction-normalizer.service';
import { classifyDegradedInput } from './services/degraded-input-classifier.service';
import { UnsupportedDegradedScriptError } from './errors/unsupported-degraded-script.error';
import {
  ScriptParserNativeExtractionPayload,
  ScriptParserResultPayload,
} from '../../contracts/script-parser.contract';
import {
  NativePdfCapabilityDetectorService,
  type NativePdfCapabilityResult,
} from './services/native-pdf-capability-detector.service';
import {
  NativePdfRoutingDecision,
  NativePdfRoutingService,
} from './services/native-pdf-routing.service';
import { GeminiSemaphoreService } from './gemini-semaphore.service';

type ExtractionSource =
  | DocumentExtractionResult['source']
  | 'legacy_pdf_parser'
  | 'legacy_docx_parser'
  | 'plain_text'
  | 'fdx_parser';

interface ExtractionAttempt {
  source: ExtractionSource;
  success: boolean;
  jobId?: string;
  warnings?: string[];
  errors?: string[];
  metadata?: Record<string, any>;
  message?: string;
  timestamp?: string;
}

interface AnalysisPathMetadata {
  pathVersion: 'phase0-baseline';
  routePattern: 'ai.script-analysis';
  structuralPath: string;
  semanticPath: string;
  parserFirstEnabled: boolean;
  parserFirstRollout: number;
  legacyAiAnalyzePathActive: false;
  updatedAt: string;
}

interface AnalysisLifecycleMetadata {
  lifecycleState: string;
  currentStage: string;
  degraded: boolean;
  attentionRequired: boolean;
  fallbackUsed: boolean;
  failureStage: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  extractionSource: string | null;
  structuralPath: string;
  semanticPath: string;
  updatedAt: string;
}

@Injectable()
export class AiOrchestratorService {
  private readonly logger = new Logger(AiOrchestratorService.name);
  private pendingStructuredWarnings: string[] | null = null;
  private pendingStructuredNormalization: StructuredNormalizationResult | null =
    null;
  private pendingAnalysisPathMetadata: AnalysisPathMetadata | null = null;
  private pendingNativePdfCapability: NativePdfCapabilityResult | null = null;
  private pendingExtractionPathMetadata: Record<string, any> | null = null;
  private pendingNativePdfWatermarkSuppression: Record<string, any> | null =
    null;
  private pendingParserNativeExtraction: Record<string, any> | null = null;
  private extractionAttempts: ExtractionAttempt[] = [];
  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
    private scriptRepository: ScriptRepository,
    private characterRepository: CharacterRepository,
    private sceneRepository: SceneRepository,
    private fdxParserService: FdxParserService,
    private geminiService: GeminiService,
    private adobeExtractService: AdobeExtractService,
    private documentAiExtractService: DocumentAiExtractService,
    private nativePdfExtractService: NativePdfExtractService,
    private nativePdfWatermarkSuppressionService: NativePdfWatermarkSuppressionService,
    private nativePdfQualityGateService: NativePdfQualityGateService,
    private structuredNormalizer: StructuredExtractionNormalizer,
    private nativePdfCapabilityDetector: NativePdfCapabilityDetectorService,
    private nativePdfRoutingService: NativePdfRoutingService,
    private geminiSemaphore: GeminiSemaphoreService,
    @Inject(DataSource) private dataSource: DataSource,
  ) {}

  /**
   * Analyze a script document and create database entries
   * Extracts characters, scenes, and creates all necessary database relationships
   * @param taskId - Task ID to find the existing script
   * @param projectId - Project ID the script belongs to
   */
  async analyzeScript(
    mediaUrl: string,
    mediaFileName: string | null,
    userId: string,
    projectTitle: string | null,
    taskId: string,
    projectId: string,
    onProgress?: (progress: number, message: string, step?: string) => void,
  ): Promise<{
    scriptId: string;
    characters: Array<{ id: string; name: string }>;
    scenes: Array<{ id: string; number: number }>;
    analysisResult: ScriptAnalysisResult;
    analysisLifecycle: AnalysisLifecycleMetadata;
  }> {
    onProgress?.(10, 'Fetching script document...', 'fetching');

    this.logger.log(
      `[Script Analysis] Starting analysis for media: ${mediaFileName || 'unknown'} (URL: ${mediaUrl})`,
    );
    this.logger.log(
      `[Script Analysis] Task ID: ${taskId}, Project ID: ${projectId}, User ID: ${userId}`,
    );

    // Fetch and convert script content (handles text, PDF, and .docx files)
    this.logger.log(
      '[Script Analysis] Fetching and converting script content...',
    );
    this.resetExtractionContext();
    this.setPendingAnalysisPathMetadata({
      structuralPath: 'direct_extraction',
      semanticPath: 'gemini_raw_text_semantic',
    });
    const scriptContent = await this.fetchAndConvertScriptContent(
      mediaUrl,
      mediaFileName,
      userId,
    );

    if (!scriptContent || scriptContent.trim().length === 0) {
      this.logger.error(
        '[Script Analysis] ✗ ERROR: Script content is empty or null after fetching/conversion',
      );
      throw new BadRequestException(
        'Failed to fetch script content or file is empty',
      );
    }

    const contentLength = scriptContent.trim().length;
    this.logger.log(
      `[Script Analysis] ✓ Script content fetched. Length: ${contentLength} characters`,
    );

    // Log a sample of the content for debugging
    const contentSample = scriptContent.trim().substring(0, 1000);
    this.logger.log(
      `[Script Analysis] Content sample (first 1000 chars):\n${contentSample}...`,
    );

    // Also log lines count and first few lines
    const contentLines = scriptContent.trim().split('\n');
    this.logger.log(
      `[Script Analysis] Content structure: ${contentLines.length} lines total`,
    );
    if (contentLines.length > 0) {
      const firstLines = contentLines.slice(0, 10);
      this.logger.log(
        `[Script Analysis] First 10 lines:\n${firstLines.map((line, i) => `${i + 1}: "${line}"`).join('\n')}`,
      );
    }

    onProgress?.(20, 'Validating script format...', 'validation');

    // Validate that this is actually a script document
    this.logger.log('[Script Analysis] Validating script format...');
    const isValidScript = this.isScriptDocument(scriptContent);
    const skipScriptValidation = this.configService.get<boolean>(
      'SKIP_SCRIPT_VALIDATION',
      false,
    );
    this.logger.log(
      `[Script Analysis] Script validation result: ${isValidScript ? '✓ VALID' : '✗ INVALID'}`,
    );

    if (!isValidScript && skipScriptValidation) {
      this.logger.warn(
        '[Script Analysis] Script validation bypass is enabled. Continuing despite invalid screenplay heuristics.',
      );
    }

    if (!isValidScript && !skipScriptValidation) {
      this.logger.error(
        '[Script Analysis] ✗ ERROR: File does not appear to be a valid script document',
      );
      this.logger.error(
        `[Script Analysis] Content length: ${contentLength} chars. This may indicate:`,
      );
      this.logger.error(
        '[Script Analysis]   1. The file is not a screenplay/script',
      );
      this.logger.error(
        '[Script Analysis]   2. Text extraction failed (especially for image-based PDFs)',
      );
      this.logger.error(
        '[Script Analysis]   3. The content format is not recognized',
      );
      throw new BadRequestException(
        'The uploaded file does not appear to be a script document. Please upload a valid screenplay or script file.',
      );
    }

    this.logger.log('[Script Analysis] ✓ Script validation passed');

    onProgress?.(30, 'Analyzing script with AI...', 'analysis');

    // Analyze with Gemini (use file name as script name, not project title)
    const analysisResult = await this.analyzeWithGemini(
      scriptContent,
      mediaFileName || projectTitle || 'Untitled Script',
      onProgress,
      userId,
    );

    onProgress?.(80, 'Saving script data to database...', 'saving');

    // check if we have deterministic FDX data to use for structure
    const normalized =
      this.pendingStructuredNormalization ||
      ((this as any).__fdxParseResult
        ? {
            fdxResult: (this as any).__fdxParseResult,
            warnings: this.pendingStructuredWarnings || [],
            coverageRatio: 1,
            parsedPages: [],
          }
        : null);
    const fdxData: FdxParseResult | undefined = normalized
      ? normalized.fdxResult
      : undefined;
    if (fdxData) {
      delete (this as any).__fdxParseResult;
    }
    this.pendingStructuredNormalization = null;

    // Save to database in a transaction
    const savedData = await this.saveScriptToDatabase(
      analysisResult,
      mediaUrl,
      userId,
      projectTitle,
      mediaFileName,
      taskId,
      projectId,
      onProgress,
      fdxData,
    );

    onProgress?.(100, 'Script analysis complete!', 'completed');

    return {
      scriptId: savedData.scriptId,
      characters: savedData.characters,
      scenes: savedData.scenes,
      analysisResult,
      analysisLifecycle: savedData.analysisLifecycle,
    };
  }

  private async downloadToTempFile(
    url: string,
    fileName: string,
  ): Promise<string> {
    const buffer = await this.downloadFileAsBuffer(url);
    const tempPath = path.join(
      os.tmpdir(),
      `${Date.now()}-${(fileName || 'script').replace(/\s+/g, '_')}`,
    );
    await fs.writeFile(tempPath, buffer);
    return tempPath;
  }

  private async extractWithAdobe(
    filePath: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      const buffer = await fs.readFile(filePath);
      const extraction = await this.adobeExtractService.extract(
        buffer,
        fileName,
      );
      this.recordExtractionAttempt({
        source: extraction.source,
        success: true,
        jobId: extraction.jobId,
        warnings: extraction.warnings,
        errors: extraction.errors,
        metadata: extraction.metadata,
      });
      this.pendingStructuredNormalization =
        this.applyStructuredNormalizationResult(
          extraction.blocks,
          extraction.source,
        );
      if (!extraction.blocks.length) {
        this.logger.warn(
          '[Adobe Extract] No blocks returned; legacy parser will run instead.',
        );
        return null;
      }
      this.logger.log(
        `[Adobe Extract] ${extraction.blocks.length} blocks returned for ${fileName}`,
      );
      return this.pendingStructuredNormalization?.fdxResult.rawText || null;
    } catch (error: any) {
      this.recordExtractionAttempt({
        source: 'adobe_pdf_extract',
        success: false,
        errors: [error?.message || 'Unknown Adobe Extract error'],
        metadata: { fileName },
      });
      throw error;
    }
  }

  private async extractWithDocumentAi(
    filePath: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      const buffer = await fs.readFile(filePath);
      const extraction = await this.documentAiExtractService.extract(
        buffer,
        fileName,
      );
      this.pendingStructuredNormalization =
        this.applyStructuredNormalizationResult(
          extraction.blocks,
          extraction.source,
        );
      this.recordExtractionAttempt({
        source: extraction.source,
        success: true,
        jobId: extraction.jobId,
        warnings: extraction.warnings,
        errors: extraction.errors,
        metadata: extraction.metadata,
      });
      if (!extraction.blocks.length) {
        this.logger.warn(
          '[Document AI] No blocks returned; legacy parser will process this PDF.',
        );
        return null;
      }
      this.logger.log(
        `[Document AI] ${extraction.blocks.length} blocks produced for ${fileName}`,
      );
      return this.pendingStructuredNormalization?.fdxResult.rawText || null;
    } catch (error: any) {
      this.recordExtractionAttempt({
        source: 'google_document_ai',
        success: false,
        errors: [error?.message || 'Unknown Document AI error'],
        metadata: { fileName },
      });
      throw error;
    }
  }

  private async extractWithNativePdfTextLayer(
    filePath: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      const buffer = await fs.readFile(filePath);
      const extraction = await this.nativePdfExtractService.extract(
        buffer,
        fileName,
      );
      const suppressionResult =
        this.nativePdfWatermarkSuppressionService.suppress(extraction.blocks);
      const warnings = [
        ...(extraction.warnings || []),
        ...suppressionResult.warnings,
      ];
      this.pendingStructuredNormalization =
        this.applyStructuredNormalizationResult(
          suppressionResult.blocks,
          extraction.source,
        );
      this.pendingNativePdfWatermarkSuppression = {
        watermarkDetected: suppressionResult.watermarkDetected,
        removedHeaderFooterCount: suppressionResult.removedHeaderFooterCount,
        removedWatermarkCount: suppressionResult.removedWatermarkCount,
        watermarkTexts: suppressionResult.watermarkTexts,
        updatedAt: new Date().toISOString(),
      };
      const qualityGate = this.nativePdfQualityGateService.evaluate(
        this.pendingStructuredNormalization,
        {
          pageCount:
            typeof extraction.metadata?.pageCount === 'number'
              ? extraction.metadata.pageCount
              : null,
        },
      );
      this.recordExtractionAttempt({
        source: extraction.source,
        success: true,
        warnings,
        errors: extraction.errors,
        metadata: {
          ...(extraction.metadata || {}),
          watermarkSuppression: this.pendingNativePdfWatermarkSuppression,
          qualityGate,
        },
      });
      if (!suppressionResult.blocks.length) {
        this.logger.warn(
          '[Native PDF Extract] No positioned blocks returned; fallback routing will continue.',
        );
        return null;
      }
      if (!qualityGate.accepted) {
        this.pendingStructuredNormalization = null;
        this.pendingStructuredWarnings = null;
        this.pendingExtractionPathMetadata = {
          ...(this.pendingExtractionPathMetadata || {}),
          fallbackReason: qualityGate.reasons,
          nativeQualityGate: qualityGate,
        };
        this.logger.warn(
          `[Native PDF Extract] Quality gate rejected native extraction ${JSON.stringify(
            {
              fileName,
              reasons: qualityGate.reasons,
              metrics: qualityGate.metrics,
            },
          )}`,
        );
        return null;
      }
      this.logger.log(
        `[Native PDF Extract] ${suppressionResult.blocks.length} blocks returned for ${fileName} after suppression`,
      );
      return this.pendingStructuredNormalization?.fdxResult.rawText || null;
    } catch (error: any) {
      this.recordExtractionAttempt({
        source: 'native_pdf_text_layer',
        success: false,
        errors: [error?.message || 'Unknown native PDF extraction error'],
        metadata: { fileName },
      });
      throw error;
    }
  }

  async debugExtract(
    mediaUrl: string,
    mediaFileName: string | null,
  ): Promise<any> {
    this.logger.log(
      `[Debug Extract] Starting extractor test for ${mediaFileName || mediaUrl}`,
    );
    try {
      const rawText = await this.fetchAndConvertScriptContent(
        mediaUrl,
        mediaFileName,
      );
      const normalized = this.pendingStructuredNormalization;
      const warnings = this.pendingStructuredWarnings ?? [];
      const structuralFlags = normalized?.structuralFlags ?? null;
      const extractionAttempts = [...this.extractionAttempts];

      return {
        rawText,
        rawTextPreview: rawText.split('\n').slice(0, 40).join('\n'),
        rawTextLength: rawText.length,
        sceneCount: normalized?.fdxResult.scenes.length ?? 0,
        extractionAttempts,
        warnings,
        structuralFlags,
        fdxResult: normalized?.fdxResult ?? null,
      };
    } finally {
      this.resetExtractionContext();
    }
  }

  private applyStructuredNormalizationResult(
    blocks: ExtractedBlock[],
    source: string,
  ): StructuredNormalizationResult | null {
    const normalized = this.structuredNormalizer.normalizeToFdx(blocks);
    if (!normalized) {
      return null;
    }

    (this as any).__fdxParseResult = normalized.fdxResult;
    this.pendingStructuredWarnings = normalized.warnings;
    this.logger.debug(
      `[Structured Normalizer] Produced ${normalized.fdxResult.scenes.length} scenes from ${source}`,
    );
    if (normalized.fdxResult.rawText) {
      const snippet = normalized.fdxResult.rawText
        .split('\n')
        .slice(0, 20)
        .join('\n');
      this.logger.debug(
        `[Structured Normalizer] Clean text preview (${Math.min(
          20,
          normalized.fdxResult.rawText.split('\n').length,
        )} lines):\n${snippet}`,
      );
    }
    return normalized;
  }

  private resetExtractionContext() {
    this.pendingStructuredWarnings = null;
    this.pendingStructuredNormalization = null;
    this.pendingAnalysisPathMetadata = null;
    this.pendingNativePdfCapability = null;
    this.pendingExtractionPathMetadata = null;
    this.pendingNativePdfWatermarkSuppression = null;
    this.pendingParserNativeExtraction = null;
    this.extractionAttempts = [];
  }

  private async detectNativePdfCapability(
    filePath: string,
    fileName: string | null,
  ): Promise<void> {
    const enabled = this.configService.get<boolean>(
      'ENABLE_NATIVE_PDF_CAPABILITY_DETECTION',
      false,
    );
    if (!enabled) {
      this.pendingNativePdfCapability = null;
      return;
    }

    try {
      const buffer = await fs.readFile(filePath);
      const capability = await this.nativePdfCapabilityDetector.detect(
        buffer,
        fileName,
      );
      this.pendingNativePdfCapability = capability;
      this.logger.log(
        `[NativePdfCapability] ${JSON.stringify({
          fileName: fileName || null,
          nativeTextLayerDetected: capability.nativeTextLayerDetected,
          nativeTextLayerStrength: capability.nativeTextLayerStrength,
          recommendedPath: capability.recommendedPath,
          reasons: capability.reasons,
          signals: capability.signals,
        })}`,
      );
    } catch (error: any) {
      this.pendingNativePdfCapability = null;
      this.logger.warn(
        `[NativePdfCapability] Detection failed for ${fileName || 'unknown'}: ${error?.message || 'unknown error'}`,
      );
    }
  }

  private setPendingAnalysisPathMetadata(
    metadata: Pick<AnalysisPathMetadata, 'structuralPath' | 'semanticPath'>,
  ) {
    this.pendingAnalysisPathMetadata = {
      pathVersion: 'phase0-baseline',
      routePattern: 'ai.script-analysis',
      structuralPath: metadata.structuralPath,
      semanticPath: metadata.semanticPath,
      parserFirstEnabled: this.configService.get<boolean>(
        'ENABLE_PARSER_FIRST_ANALYSIS',
        false,
      ),
      parserFirstRollout: this.configService.get<number>(
        'PARSER_FIRST_ANALYSIS_ROLLOUT',
        0,
      ),
      legacyAiAnalyzePathActive: false,
      updatedAt: new Date().toISOString(),
    };
  }

  private matchesRollout(
    key: string | null,
    enabled: boolean,
    rollout: number,
  ): boolean {
    if (!enabled) return false;
    if (rollout >= 100) return true;
    if (rollout <= 0) return false;

    const stableKey = (key || '').toLowerCase() || crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(stableKey).digest();
    const bucket = hash[0] % 100;
    return bucket < rollout;
  }

  private buildParserMetadataFromParseResult(
    parseResult: ScriptParserResultPayload,
  ) {
    const parsedPages = Array.from(
      new Set(
        parseResult.scenes.flatMap((scene) => {
          const start = scene.page_start ?? null;
          const end = scene.page_end ?? null;
          if (start && end && end >= start) {
            return Array.from(
              { length: end - start + 1 },
              (_, index) => start + index,
            );
          }
          return start ? [start] : [];
        }),
      ),
    ).sort((a, b) => a - b);

    const pageCount = Math.max(parseResult.page_count || 0, parsedPages.length);

    // When scenes exist with elements but lack page boundaries (e.g. text
    // heuristic / Gemini-extracted text), infer coverage from scene data
    // rather than reporting 0.  This prevents the degraded-input classifier
    // from rejecting scripts whose text was extracted successfully but whose
    // structural parser couldn't assign page ranges.
    const scenesHaveContent =
      parsedPages.length === 0 &&
      parseResult.scenes.length > 0 &&
      parseResult.scenes.some((s) => s.elements.length > 0);

    const coverageRatio = scenesHaveContent
      ? 1 // text was extracted, structure exists — treat as full coverage
      : pageCount > 0
        ? parsedPages.length / pageCount
        : parsedPages.length
          ? 1
          : 0;

    // When scenes have content but no page boundaries, report
    // parsedPageCount = pageCount so the degraded-input classifier
    // doesn't fire "Parser did not recover any usable pages."
    const effectiveParsedPageCount = scenesHaveContent
      ? pageCount
      : parsedPages.length;

    const missingPageNumbers =
      pageCount > 0
        ? Array.from({ length: pageCount }, (_, index) => index + 1).filter(
            (pageNumber) => !parsedPages.includes(pageNumber),
          )
        : [];

    const elementTypeCounts = parseResult.scenes.reduce<Record<string, number>>(
      (acc, scene) => {
        for (const element of scene.elements) {
          acc[element.type] = (acc[element.type] || 0) + 1;
        }
        return acc;
      },
      {},
    );

    const classificationWarnings: string[] = [];
    if ((elementTypeCounts.dialogue || 0) === 0) {
      classificationWarnings.push(
        'Parser returned zero dialogue elements. Dialogue/action classification may be damaged.',
      );
    }
    if (
      (elementTypeCounts.action || 0) > 0 &&
      (elementTypeCounts.dialogue || 0) > 0 &&
      elementTypeCounts.action > elementTypeCounts.dialogue * 5
    ) {
      classificationWarnings.push(
        'Action elements heavily outnumber dialogue elements. Review watermark/layout damage if output looks wrong.',
      );
    }

    const sceneStructure = parseResult.scenes.map((scene) => {
      const sceneElementCounts = scene.elements.reduce<Record<string, number>>(
        (acc, element) => {
          acc[element.type] = (acc[element.type] || 0) + 1;
          return acc;
        },
        {},
      );

      return {
        number: scene.number,
        scriptSceneNumber: scene.script_scene_number || null,
        heading: scene.heading,
        pageStart: scene.page_start ?? null,
        pageEnd: scene.page_end ?? null,
        location: scene.location || null,
        timeOfDay: scene.time_of_day || null,
        interiorExterior: scene.interior_exterior || null,
        elementCounts: sceneElementCounts,
        sampleElements: scene.elements.slice(0, 6).map((element) => ({
          type: element.type,
          characterName: element.character_name || null,
          revised: element.revised === true,
          textPreview:
            element.text.length > 120
              ? `${element.text.slice(0, 117)}...`
              : element.text,
        })),
      };
    });

    return {
      parserVersion: 'python_router_v1',
      parserFormat: parseResult.format,
      extractionSource: `script_parser:${parseResult.format}`,
      parserWarnings: parseResult.parser_warnings || [],
      structuralWarnings: Array.from(
        new Set([
          ...(parseResult.parser_warnings || []),
          ...classificationWarnings,
        ]),
      ),
      structuralClassificationWarnings: classificationWarnings,
      structureConfidenceScore: parseResult.structure_confidence_score,
      lowConfidenceFlag: parseResult.low_confidence_flag,
      stagePlayDetected: parseResult.stage_play_detected,
      watermarkDetected: parseResult.watermark_detected,
      watermarkTexts: parseResult.watermark_texts || [],
      pageCount,
      parsedPageCount: effectiveParsedPageCount,
      parsedPages,
      missingPageNumbers,
      coverageRatio,
      pageCoverageRatio: coverageRatio,
      sceneCount: parseResult.scenes.length,
      characterCount: parseResult.characters.length,
      scenePageMap: parseResult.scenes.map((scene) => ({
        number: scene.number,
        heading: scene.heading,
        pageStart: scene.page_start ?? null,
        pageEnd: scene.page_end ?? null,
      })),
      elementTypeCounts,
      characterLineCounts:
        parseResult.characters.length > 0
          ? parseResult.characters.map((character) => ({
              name: character.name,
              lineCount: character.line_count,
            }))
          : // Derive from scene dialogue elements when parser didn't build
            // a top-level characters list (e.g. text heuristic parser)
            Object.entries(
              parseResult.scenes.reduce<Record<string, number>>(
                (acc, scene) => {
                  for (const el of scene.elements) {
                    if (el.character_name) {
                      acc[el.character_name] =
                        (acc[el.character_name] || 0) + 1;
                    }
                  }
                  return acc;
                },
                {},
              ),
            ).map(([name, lineCount]) => ({ name, lineCount })),
      structureDebug: {
        sceneStructure,
        rawTextLength: parseResult.raw_text.length,
        cleanTextLength: parseResult.clean_text.length,
      },
      metadataUpdatedAt: new Date().toISOString(),
    };
  }

  private mapScriptParserNativeBlocks(
    nativeExtraction: ScriptParserNativeExtractionPayload,
  ): ExtractedBlock[] {
    return (nativeExtraction.blocks || []).map((block) => {
      const attributes = (block.attributes || {}) as Record<string, any>;
      const fontSize =
        typeof attributes.font_size === 'number'
          ? attributes.font_size
          : typeof attributes.fontSize === 'number'
            ? attributes.fontSize
            : null;
      const rotationDegrees =
        typeof attributes.rotation_degrees === 'number'
          ? attributes.rotation_degrees
          : typeof attributes.rotationDegrees === 'number'
            ? attributes.rotationDegrees
            : null;

      return {
        text: block.text,
        page: block.page,
        boundingBox: Array.isArray(block.bounding_box)
          ? block.bounding_box
          : undefined,
        attributes: {
          ...attributes,
          fontSize,
          rotationDegrees,
        },
      };
    });
  }

  private consumeParserNativeExtraction(
    nativeExtraction: ScriptParserNativeExtractionPayload,
    context: {
      taskId: string;
      projectId: string;
      scriptName: string;
    },
  ) {
    const mappedBlocks = this.mapScriptParserNativeBlocks(nativeExtraction);
    const metadata = (nativeExtraction.metadata || {}) as Record<string, any>;
    const warnings = Array.isArray(nativeExtraction.warnings)
      ? nativeExtraction.warnings
      : [];

    this.pendingParserNativeExtraction = {
      source: nativeExtraction.source,
      blockCount: mappedBlocks.length,
      warningCount: warnings.length,
      warnings,
      metadata,
      updatedAt: new Date().toISOString(),
    };
    this.pendingExtractionPathMetadata = {
      ...(this.pendingExtractionPathMetadata || {}),
      parserNativeExtractionAvailable: true,
      parserNativeExtractionSource: nativeExtraction.source,
      parserNativeExtractionBlockCount: mappedBlocks.length,
      parserNativeExtractionBridgeUsed: true,
    };

    const removedWatermarkCount =
      typeof metadata.removed_watermark_count === 'number'
        ? metadata.removed_watermark_count
        : 0;
    const removedHeaderFooterCount =
      typeof metadata.removed_header_footer_count === 'number'
        ? metadata.removed_header_footer_count
        : 0;
    const watermarkTexts = Array.isArray(metadata.watermark_texts)
      ? metadata.watermark_texts
      : [];
    this.pendingNativePdfWatermarkSuppression = {
      watermarkDetected: removedWatermarkCount > 0 || watermarkTexts.length > 0,
      removedHeaderFooterCount,
      removedWatermarkCount,
      watermarkTexts,
      updatedAt: new Date().toISOString(),
      source: nativeExtraction.source,
    };

    const normalized = this.applyStructuredNormalizationResult(
      mappedBlocks,
      nativeExtraction.source,
    );
    if (normalized) {
      const qualityGate = this.nativePdfQualityGateService.evaluate(
        normalized,
        {
          pageCount:
            typeof metadata.page_count === 'number'
              ? metadata.page_count
              : null,
        },
      );
      this.pendingParserNativeExtraction.structuredNormalization = {
        coverageRatio: normalized.coverageRatio,
        parsedPages: normalized.parsedPages,
        pagesParsedRatio: normalized.pagesParsedRatio ?? null,
        structuralFlags: normalized.structuralFlags || {},
      };
      this.pendingParserNativeExtraction.qualityGate = qualityGate;
      this.pendingExtractionPathMetadata = {
        ...(this.pendingExtractionPathMetadata || {}),
        parserNativeExtractionQualityGate: qualityGate,
      };
    }

    this.logger.log(
      `[ParserFirst] Native extraction payload ${JSON.stringify({
        taskId: context.taskId,
        projectId: context.projectId,
        scriptName: context.scriptName,
        source: nativeExtraction.source,
        blockCount: mappedBlocks.length,
        warningCount: warnings.length,
        metadata: {
          pageCount:
            typeof metadata.page_count === 'number'
              ? metadata.page_count
              : null,
          pagesWithBlocks:
            typeof metadata.pages_with_blocks === 'number'
              ? metadata.pages_with_blocks
              : null,
          nativeTextLayerStrength: metadata.native_text_layer_strength || null,
          screenplaySignalScore:
            typeof metadata.screenplay_signal_score === 'number'
              ? metadata.screenplay_signal_score
              : null,
          noiseSignalScore:
            typeof metadata.noise_signal_score === 'number'
              ? metadata.noise_signal_score
              : null,
          layoutCoherenceScore:
            typeof metadata.layout_coherence_score === 'number'
              ? metadata.layout_coherence_score
              : null,
          removedWatermarkCount,
          removedHeaderFooterCount,
          watermarkTexts,
        },
      })}`,
    );
  }

  private shouldUseParserNativeExtractionBridge(
    nativeExtraction: ScriptParserNativeExtractionPayload | null,
    context: {
      taskId: string;
      scriptName: string;
    },
  ): {
    allowed: boolean;
    reason: string;
    enabled: boolean;
    rollout: number;
    rolloutMatched: boolean;
  } {
    const enabled = this.configService.get<boolean>(
      'ENABLE_PYMUPDF_NATIVE_EXTRACTION_BRIDGE',
      false,
    );
    const rollout = this.configService.get<number>(
      'PYMUPDF_NATIVE_EXTRACTION_BRIDGE_ROLLOUT',
      0,
    );
    const rolloutMatched = this.matchesRollout(
      context.scriptName || context.taskId,
      enabled,
      rollout,
    );

    if (!nativeExtraction?.blocks?.length) {
      return {
        allowed: false,
        reason:
          'PyMuPDF native extraction payload was absent or empty; continuing without the bridge.',
        enabled,
        rollout,
        rolloutMatched,
      };
    }
    if (!enabled) {
      return {
        allowed: false,
        reason:
          'PyMuPDF native extraction bridge is disabled; rollback remains on the existing path.',
        enabled,
        rollout,
        rolloutMatched,
      };
    }
    if (!rolloutMatched) {
      return {
        allowed: false,
        reason: `PyMuPDF native extraction bridge rollout skipped this file (rollout ${rollout}%).`,
        enabled,
        rollout,
        rolloutMatched,
      };
    }

    const metadata = (nativeExtraction.metadata || {}) as Record<string, any>;
    if (metadata.native_text_layer_strength === 'absent') {
      return {
        allowed: false,
        reason:
          'PyMuPDF native extraction reported absent native text strength; keeping the existing path active.',
        enabled,
        rollout,
        rolloutMatched,
      };
    }

    return {
      allowed: true,
      reason: 'PyMuPDF native extraction bridge is enabled for this file.',
      enabled,
      rollout,
      rolloutMatched,
    };
  }

  private buildSuccessAnalysisLifecycleMetadata(options: {
    extractionSource: string | null;
    analysisPath: AnalysisPathMetadata;
    semanticMetadata?: Record<string, any>;
  }): AnalysisLifecycleMetadata {
    const semanticMetadata = options.semanticMetadata || {};
    const qualityGate = semanticMetadata.qualityGate || {};
    const fallbackUsed = Boolean(semanticMetadata.synthesisFallbackUsed);
    const degraded = Boolean(
      fallbackUsed ||
        (Array.isArray(qualityGate.reasons) && qualityGate.reasons.length > 0),
    );

    return {
      lifecycleState: fallbackUsed
        ? 'completed_with_fallback'
        : degraded
          ? 'completed_with_attention'
          : 'completed',
      currentStage: 'completed',
      degraded,
      attentionRequired: degraded,
      fallbackUsed,
      failureStage: null,
      failureCode: null,
      failureMessage: null,
      extractionSource: options.extractionSource,
      structuralPath: options.analysisPath.structuralPath,
      semanticPath: options.analysisPath.semanticPath,
      updatedAt: new Date().toISOString(),
    };
  }

  private shouldUseExternalExtractor(
    fileExtension: string,
    fileName: string | null,
  ): boolean {
    if (fileExtension !== 'pdf') {
      return false;
    }

    const enabled = this.configService.get<boolean>(
      'USE_EXTERNAL_PDF_EXTRACTOR',
      false,
    );
    if (!enabled) {
      return false;
    }

    if (
      !this.adobeExtractService.isConfigured &&
      !this.documentAiExtractService.isConfigured
    ) {
      this.logger.warn(
        '[Content Fetch] USE_EXTERNAL_PDF_EXTRACTOR enabled but no extractor credentials are configured.',
      );
      return false;
    }

    const rollout = this.configService.get<number>(
      'EXTERNAL_PDF_EXTRACTOR_ROLLOUT',
      100,
    );
    if (rollout >= 100) return true;
    if (rollout <= 0) return false;

    const key = (fileName || '').toLowerCase() || crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(key).digest();
    const bucket = hash[0] % 100;
    const decision = bucket < rollout;
    if (!decision) {
      this.logger.log(
        `[Content Fetch] External extractor rollout skipped for "${fileName || 'unknown'}" (bucket ${bucket}, rollout ${rollout}%).`,
      );
    }
    return decision;
  }

  private recordExtractionAttempt(attempt: ExtractionAttempt) {
    const payload = {
      timestamp: new Date().toISOString(),
      ...attempt,
    };
    this.extractionAttempts.push(payload);
    const attemptIndex = this.extractionAttempts.length;
    this.logger.log(
      `[ExtractionTelemetry] Attempt #${attemptIndex} (${payload.source}) => ${payload.success ? 'success' : 'failure'}${payload.message ? ` - ${payload.message}` : ''}`,
    );
  }

  private getFinalExtractionSource(): ExtractionSource | undefined {
    return (
      this.extractionAttempts
        .slice()
        .reverse()
        .find((attempt) => attempt.success)?.source ??
      this.extractionAttempts[this.extractionAttempts.length - 1]?.source
    );
  }

  private logExtractionSummary(options?: {
    taskId?: string;
    fileName?: string;
    finalSource?: ExtractionSource;
  }) {
    if (!this.extractionAttempts.length) return;
    const summarySource =
      options?.finalSource ?? this.getFinalExtractionSource();
    const attemptSummaries = this.extractionAttempts.map((attempt, index) => ({
      index: index + 1,
      source: attempt.source,
      success: attempt.success,
      jobId: attempt.jobId,
      warnings: attempt.warnings?.length ?? 0,
      errors: attempt.errors?.length ?? 0,
    }));
    const failureCount = attemptSummaries.filter((a) => !a.success).length;
    const stats = this.extractionAttempts.reduce<Record<string, number>>(
      (acc, attempt) => {
        acc[attempt.source] = (acc[attempt.source] || 0) + 1;
        return acc;
      },
      {},
    );
    this.logger.log(
      `[ExtractionTelemetry] Summary ${JSON.stringify({
        taskId: options?.taskId,
        fileName: options?.fileName,
        finalSource: summarySource,
        attempts: attemptSummaries.length,
        failuresBeforeSuccess: failureCount,
        counts: stats,
        chain: attemptSummaries,
      })}`,
    );
  }

  /**
   * Fetch and convert script content from URL
   * Handles plain text, PDF, and .docx files
   */
  private async fetchAndConvertScriptContent(
    url: string,
    fileName: string | null,
    userId?: string,
  ): Promise<string> {
    this.logger.log(
      `[Content Fetch] Starting content fetch/convert. URL: ${url}, File: ${fileName || 'unknown'}`,
    );

    const fileExtension = fileName
      ? fileName.toLowerCase().split('.').pop() || ''
      : '';

    this.logger.log(
      `[Content Fetch] Detected file extension: ${fileExtension || 'none'}`,
    );

    try {
      // For FDX files, download and parse with deterministic XML parser
      if (fileExtension === 'fdx') {
        this.logger.log(
          `[Content Fetch] Processing as FDX (Final Draft) file: ${fileName}`,
        );
        const buffer = await this.downloadFileAsBuffer(url);
        const fdxResult = await this.fdxParserService.parse(buffer);
        this.recordExtractionAttempt({
          source: 'fdx_parser',
          success: true,
          metadata: {
            scenes: fdxResult.scenes.length,
            characters: fdxResult.characters.length,
          },
        });
        // Store parsed FDX data on the instance so analyzeScript can use it
        // instead of sending raw text through Gemini for structural extraction
        (this as any).__fdxParseResult = fdxResult;
        this.logger.log(
          `[Content Fetch] ✓ FDX parsed: ${fdxResult.scenes.length} scenes, ${fdxResult.characters.length} characters`,
        );
        // Return the raw text for Gemini deep analysis (themes, tone, etc.)
        return fdxResult.rawText;
      }

      // For text files (.txt, .text, .script), fetch directly as text - no conversion needed
      if (['txt', 'text', 'script'].includes(fileExtension)) {
        this.logger.log(
          `[Content Fetch] Processing as text file (${fileExtension}): ${fileName}`,
        );
        const textContent = await this.fetchTextContent(url);
        this.logger.log(
          `[Content Fetch] Text file fetched. Length: ${textContent.length} characters`,
        );

        // Verify it's actually text (not binary mislabeled as .txt)
        if (this.isBinaryContent(textContent)) {
          this.logger.warn(
            `[Content Fetch] ⚠ WARNING: File ${fileName} has .txt extension but contains binary data. Attempting to detect format.`,
          );
          // Fall through to binary detection below
        } else {
          // Valid text file - return immediately
          this.logger.log(
            '[Content Fetch] ✓ Valid text file, returning content',
          );
          this.recordExtractionAttempt({
            source: 'plain_text',
            success: true,
            metadata: { extension: fileExtension },
          });
          return textContent;
        }
      }

      const useExternalExtractor = this.shouldUseExternalExtractor(
        fileExtension,
        fileName,
      );

      // For binary files (.docx, .pdf), download to temp and convert
      if (fileExtension === 'docx' || fileExtension === 'pdf') {
        this.logger.log(
          `[Content Fetch] Processing as binary file (${fileExtension}): ${fileName}`,
        );
        const tempFile = await this.downloadToTempFile(url, fileName);
        let nativePdfRoutingDecision: NativePdfRoutingDecision | null = null;
        if (fileExtension === 'pdf') {
          await this.detectNativePdfCapability(tempFile, fileName);
          nativePdfRoutingDecision = this.nativePdfRoutingService.decide({
            fileName,
            capability: this.pendingNativePdfCapability,
            nativeRoutingEnabled: this.configService.get<boolean>(
              'ENABLE_NATIVE_PDF_FIRST_ROUTING',
              false,
            ),
            nativeRoutingRollout: this.configService.get<number>(
              'NATIVE_PDF_FIRST_ROUTING_ROLLOUT',
              0,
            ),
            externalExtractorEligible: useExternalExtractor,
          });
          this.pendingExtractionPathMetadata = {
            ...(this.pendingExtractionPathMetadata || {}),
            nativePdfFirstEnabled: this.configService.get<boolean>(
              'ENABLE_NATIVE_PDF_FIRST_ROUTING',
              false,
            ),
            nativePdfFirstRollout: this.configService.get<number>(
              'NATIVE_PDF_FIRST_ROUTING_ROLLOUT',
              0,
            ),
            initialExtractionPath:
              nativePdfRoutingDecision.initialExtractionPath,
            nativeFirstApplied: nativePdfRoutingDecision.nativeFirstApplied,
            routingReasons: nativePdfRoutingDecision.reasons,
            capabilityStrength:
              this.pendingNativePdfCapability?.nativeTextLayerStrength || null,
          };
          this.logger.log(
            `[ExtractionRouting] ${JSON.stringify({
              fileName: fileName || null,
              initialExtractionPath:
                nativePdfRoutingDecision.initialExtractionPath,
              nativeFirstApplied: nativePdfRoutingDecision.nativeFirstApplied,
              rolloutMatched: nativePdfRoutingDecision.rolloutMatched,
              reasons: nativePdfRoutingDecision.reasons,
              capabilityStrength:
                this.pendingNativePdfCapability?.nativeTextLayerStrength ||
                null,
            })}`,
          );
        }
        let convertedContent: string | undefined;
        const shouldUseExternalExtractorFirst =
          fileExtension === 'pdf'
            ? nativePdfRoutingDecision?.initialExtractionPath ===
              'external_extractor'
            : false;
        const shouldUseNativePdfFirst =
          fileExtension === 'pdf'
            ? nativePdfRoutingDecision?.initialExtractionPath ===
              'native_text_first'
            : false;
        if (fileExtension === 'pdf' && shouldUseNativePdfFirst) {
          try {
            convertedContent = await this.extractWithNativePdfTextLayer(
              tempFile,
              fileName,
            );
          } catch (nativePdfError: any) {
            this.logger.warn(
              `[Content Fetch] Native PDF extraction failed: ${nativePdfError.message}`,
            );
          }
        }
        if (fileExtension === 'pdf' && shouldUseExternalExtractorFirst) {
          try {
            convertedContent = await this.extractWithAdobe(tempFile, fileName);
          } catch (extractError: any) {
            this.logger.warn(
              `[Content Fetch] Adobe extraction failed: ${extractError.message}`,
            );
          }

          if (!convertedContent && this.documentAiExtractService.isConfigured) {
            try {
              convertedContent = await this.extractWithDocumentAi(
                tempFile,
                fileName,
              );
            } catch (docAiError: any) {
              this.logger.warn(
                `[Content Fetch] Document AI extraction failed: ${docAiError.message}`,
              );
            }
          }
        }
        if (
          fileExtension === 'pdf' &&
          !convertedContent &&
          shouldUseNativePdfFirst &&
          useExternalExtractor
        ) {
          try {
            convertedContent = await this.extractWithAdobe(tempFile, fileName);
          } catch (extractError: any) {
            this.logger.warn(
              `[Content Fetch] Adobe extraction failed after native PDF fallback: ${extractError.message}`,
            );
          }

          if (!convertedContent && this.documentAiExtractService.isConfigured) {
            try {
              convertedContent = await this.extractWithDocumentAi(
                tempFile,
                fileName,
              );
            } catch (docAiError: any) {
              this.logger.warn(
                `[Content Fetch] Document AI extraction failed after native PDF fallback: ${docAiError.message}`,
              );
            }
          }
        }
        if (!convertedContent) {
          if (fileExtension === 'docx') {
            convertedContent = await this.extractTextFromDocx(tempFile);
          } else {
            convertedContent = await this.extractTextFromPdf(tempFile, userId);
          }
          const legacySource =
            fileExtension === 'pdf'
              ? 'legacy_pdf_parser'
              : 'legacy_docx_parser';
          this.recordExtractionAttempt({
            source: legacySource,
            success: true,
            metadata: {
              extension: fileExtension,
              reason: useExternalExtractor
                ? 'legacy_fallback'
                : 'legacy_primary',
            },
          });
        }
        await fs.rm(tempFile).catch(() => null);
        this.logger.log(
          `[Content Fetch] ✓ Binary file converted. Length: ${convertedContent.length} characters`,
        );
        return convertedContent;
      }

      // For unknown formats or mislabeled files, try as text first, then detect binary
      this.logger.log(
        `[Content Fetch] Unknown file format (${fileExtension || 'no extension'}): ${fileName}. Attempting text fetch first.`,
      );
      const textContent = await this.fetchTextContent(url);
      this.logger.log(
        `[Content Fetch] Fetched content. Length: ${textContent.length} characters`,
      );

      // Check if content is binary
      if (this.isBinaryContent(textContent)) {
        this.logger.warn(
          '[Content Fetch] ⚠ WARNING: Content appears to be binary. Attempting format detection...',
        );
        // Try to detect format from content
        if (textContent.includes('word/') || textContent.startsWith('PK')) {
          // Likely .docx
          this.logger.log(
            '[Content Fetch] Detected .docx format from content, attempting conversion',
          );
          return await this.downloadAndConvertBinaryFile(
            url,
            'docx' as 'docx' | 'pdf',
            userId,
          );
        }
        if (textContent.includes('%PDF')) {
          // Likely PDF
          this.logger.log(
            '[Content Fetch] Detected PDF format from content, attempting conversion',
          );
          return await this.downloadAndConvertBinaryFile(
            url,
            'pdf' as 'docx' | 'pdf',
            userId,
          );
        }

        this.logger.error(
          '[Content Fetch] ✗ ERROR: Binary format detected but cannot identify type',
        );
        throw new BadRequestException(
          'The uploaded file appears to be a binary format that cannot be processed. ' +
            'Please convert your script to plain text (.txt) or PDF (.pdf) format.',
        );
      }

      // Valid text content (either .txt file or unknown format that's actually text)
      this.logger.log('[Content Fetch] ✓ Successfully fetched text content');
      this.recordExtractionAttempt({
        source: 'plain_text',
        success: true,
        metadata: { extension: fileExtension || 'unknown' },
      });
      return textContent;
    } catch (error: any) {
      this.logger.error(
        `[Content Fetch] ✗ ERROR: Failed to fetch/convert script from URL ${url}`,
      );
      this.logger.error(
        `[Content Fetch] Error message: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to process script file: ${error.message}`,
      );
    }
  }

  /**
   * Fetch text content from URL
   */
  private async fetchTextContent(url: string): Promise<string> {
    const response = await firstValueFrom(
      this.httpService.get(url, {
        responseType: 'text',
        maxContentLength: 10 * 1024 * 1024, // 10MB limit
        timeout: 30000,
      }),
    );
    return response.data || '';
  }

  /**
   * Download file from URL as a Buffer (for FDX and other binary formats)
   */
  private async downloadFileAsBuffer(url: string): Promise<Buffer> {
    const response = await firstValueFrom(
      this.httpService.get(url, {
        responseType: 'arraybuffer',
        maxContentLength: 10 * 1024 * 1024,
        timeout: 60000,
      }),
    );
    return Buffer.from(response.data);
  }

  /**
   * Download binary file to temp directory and convert to text
   */
  private async downloadAndConvertBinaryFile(
    url: string,
    format: 'docx' | 'pdf',
    userId?: string,
  ): Promise<string> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');

    let tempFilePath: string | null = null;

    try {
      // Create temp file
      const tempDir = os.tmpdir();
      const tempFileName = `script-${Date.now()}-${Math.random().toString(36).substring(7)}.${format}`;
      tempFilePath = path.join(tempDir, tempFileName);

      this.logger.debug(`Downloading file to temp: ${tempFilePath}`);

      // Download file as buffer with retry logic and better timeout handling
      let response: any;
      const maxRetries = 3;
      let lastError: any;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          this.logger.debug(
            `Downloading file from S3 (attempt ${attempt}/${maxRetries})`,
          );
          response = await firstValueFrom(
            this.httpService.get(url, {
              responseType: 'arraybuffer',
              maxContentLength: 10 * 1024 * 1024, // 10MB limit
              timeout: 60000, // Increased to 60 seconds
              maxRedirects: 5,
              validateStatus: (status) => status < 500, // Don't throw on 4xx
            }),
          );

          // Check if response is valid
          if (response.status >= 400) {
            throw new Error(
              `HTTP ${response.status}: Failed to download file from S3`,
            );
          }

          break; // Success, exit retry loop
        } catch (error: any) {
          lastError = error;
          this.logger.warn(
            `Download attempt ${attempt} failed: ${error.message}`,
          );

          if (attempt < maxRetries) {
            // Wait before retrying (exponential backoff)
            const delay = Math.min(1000 * 2 ** (attempt - 1), 5000);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!response) {
        throw new BadRequestException(
          `Failed to download file from S3 after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
        );
      }

      // Write to temp file
      await fs.writeFile(tempFilePath, Buffer.from(response.data));

      this.logger.log(
        `[Content Fetch] File downloaded successfully. Extracting text from ${format.toUpperCase()}...`,
      );

      // Convert based on format
      let textContent: string;
      if (format === 'docx') {
        this.logger.log('[Content Fetch] Extracting text from DOCX file...');
        textContent = await this.extractTextFromDocx(tempFilePath);
        this.logger.log(
          `[Content Fetch] ✓ DOCX extraction complete. Length: ${textContent.length} characters`,
        );
      } else if (format === 'pdf') {
        this.logger.log('[Content Fetch] Extracting text from PDF file...');
        textContent = await this.extractTextFromPdf(tempFilePath, userId);
        this.logger.log(
          `[Content Fetch] ✓ PDF extraction complete. Length: ${textContent.length} characters`,
        );
      } else {
        this.logger.error(
          `[Content Fetch] ✗ ERROR: Unsupported format: ${format}`,
        );
        throw new BadRequestException(`Unsupported format: ${format}`);
      }

      this.recordExtractionAttempt({
        source: format === 'pdf' ? 'legacy_pdf_parser' : 'legacy_docx_parser',
        success: true,
        metadata: { extension: format, reason: 'detected_binary' },
      });
      return textContent;
    } finally {
      // Clean up temp file
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
          this.logger.debug(`Cleaned up temp file: ${tempFilePath}`);
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to cleanup temp file ${tempFilePath}: ${cleanupError.message}`,
          );
        }
      }
    }
  }

  /**
   * Extract text from .docx file using mammoth
   */
  private async extractTextFromDocx(filePath: string): Promise<string> {
    try {
      // Use require for mammoth as it may not have proper ESM support
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require('mammoth');
      const fs = await import('fs/promises');

      const buffer = await fs.readFile(filePath);
      const result = await mammoth.extractRawText({ buffer });

      if (result.messages && result.messages.length > 0) {
        this.logger.warn(
          `Mammoth conversion warnings: ${JSON.stringify(result.messages)}`,
        );
      }

      return result.value || '';
    } catch (error: any) {
      this.logger.error(
        `Failed to extract text from .docx: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to extract text from .docx file: ${error.message}. ` +
          'Please ensure the file is a valid Word document.',
      );
    }
  }

  /**
   * Extract text from PDF file using pdf-parse with Gemini Vision fallback
   * Tries pdf-parse first, then falls back to Gemini Vision for image-based PDFs
   */
  private async extractTextFromPdf(
    filePath: string,
    userId?: string,
  ): Promise<string> {
    this.logger.log(
      `[PDF Extraction] Starting PDF text extraction from: ${filePath}`,
    );

    const pdfTextThreshold = this.configService.get<number>(
      'PDF_TEXT_THRESHOLD',
      50, // Lowered from 100 to be more aggressive in detecting image-based PDFs
    );
    const enableVisionFallback = this.configService.get<boolean>(
      'ENABLE_GEMINI_VISION_FALLBACK',
      true,
    );

    this.logger.log(
      `[PDF Extraction] Configuration - Threshold: ${pdfTextThreshold} chars, Vision Fallback: ${enableVisionFallback}`,
    );

    let textFromPdfParse = '';

    // Step 1: Try pdf-parse first (fast and cheap for text-based PDFs)
    this.logger.log(
      '[PDF Extraction] Step 1: Attempting text extraction with pdf-parse...',
    );
    try {
      this.logger.debug(`[PDF Extraction] Reading PDF file from: ${filePath}`);
      const buffer = await fs.readFile(filePath);
      this.logger.log(
        `[PDF Extraction] PDF file read successfully. Size: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
      );

      // Suppress font-related warnings from pdf-parse (pdfjs-dist)
      // These warnings are harmless and occur when PDFs have complex fonts
      const originalWarn = console.warn;
      const suppressedMessages = ['Ran out of space in font private use area'];

      console.warn = (...args: any[]) => {
        const message = args.join(' ');
        // Only suppress font-related warnings, allow all other warnings through
        if (!suppressedMessages.some((msg) => message.includes(msg))) {
          originalWarn.apply(console, args);
        }
      };

      try {
        this.logger.debug('[PDF Extraction] Calling pdf-parse library...');
        // Use require for pdf-parse as it may not have proper ESM support
        const data = await pdfParse(buffer);
        textFromPdfParse = data.text || '';
        this.logger.log(
          `[PDF Extraction] pdf-parse completed. Extracted text length: ${textFromPdfParse.length} characters (raw), ${textFromPdfParse.trim().length} characters (trimmed)`,
        );

        // Log a sample of the extracted text for debugging
        if (textFromPdfParse.trim().length > 0) {
          const sample = textFromPdfParse.trim().substring(0, 200);
          this.logger.debug(
            `[PDF Extraction] Sample of extracted text (first 200 chars): ${sample}...`,
          );
        } else {
          this.logger.warn(
            '[PDF Extraction] pdf-parse returned empty text string',
          );
        }
      } catch (parseError: any) {
        this.logger.error(
          `[PDF Extraction] pdf-parse library threw an error: ${parseError.message}`,
          parseError.stack,
        );
        throw parseError; // Re-throw to be caught by outer catch
      } finally {
        // Restore original console methods
        console.warn = originalWarn;
      }

      // Check if we got sufficient text from pdf-parse
      const textLength = textFromPdfParse.trim().length;
      this.logger.log(
        `[PDF Extraction] pdf-parse result: ${textLength} characters extracted (threshold: ${pdfTextThreshold} characters)`,
      );

      // Check if extracted text is mostly watermarks/tracking codes (BEFORE threshold check)
      // This is critical because watermarks can be long enough to pass the threshold
      this.logger.log(
        `[PDF Extraction] Checking if extracted text is watermark-only...`,
      );
      const isWatermarkOnly = this.isWatermarkOnly(textFromPdfParse);

      if (isWatermarkOnly) {
        this.logger.warn(
          `[PDF Extraction] ⚠ WARNING: pdf-parse extracted text appears to be watermarks/tracking codes only (${textLength} chars). ` +
            `This indicates an image-based PDF where only watermark text was extracted. ` +
            `${enableVisionFallback ? 'Proceeding to Gemini Vision fallback...' : 'Vision fallback is DISABLED.'}`,
        );
        // Don't return - fall through to Gemini Vision fallback
      } else if (textLength >= pdfTextThreshold) {
        this.logger.log(
          `[PDF Extraction] ✓ SUCCESS: pdf-parse extracted sufficient text (${textLength} characters). Using text-based extraction.`,
        );
        return textFromPdfParse;
      }

      // Text is too short - likely image-based PDF
      this.logger.warn(
        `[PDF Extraction] ⚠ WARNING: pdf-parse returned minimal text (${textLength} characters < ${pdfTextThreshold} threshold). ` +
          `This indicates an image-based PDF. ${enableVisionFallback ? 'Proceeding to Gemini Vision fallback...' : 'Vision fallback is DISABLED.'}`,
      );
    } catch (error: any) {
      // pdf-parse failed - log but don't throw yet, try Gemini Vision fallback
      this.logger.error(
        `[PDF Extraction] ✗ ERROR: pdf-parse failed completely. Error: ${error.message}`,
        error.stack,
      );
      this.logger.warn(
        `[PDF Extraction] ${enableVisionFallback ? 'Proceeding to Gemini Vision fallback...' : 'Vision fallback is DISABLED. Will attempt to return minimal text or throw error.'}`,
      );
    }

    // Step 2: Fallback to Gemini Vision for image-based PDFs
    if (enableVisionFallback) {
      this.logger.log(
        '[PDF Extraction] Step 2: Attempting text extraction with Gemini Vision API (for image-based PDFs)...',
      );
      try {
        const startTime = Date.now();
        this.logger.log(
          '[PDF Extraction] Calling Gemini Vision API to extract text from PDF images...',
        );

        const textFromGemini = await this.extractTextFromPdfUsingGeminiVision(
          filePath,
          userId,
        );

        const duration = Date.now() - startTime;
        this.logger.log(
          `[PDF Extraction] Gemini Vision API call completed in ${duration}ms`,
        );

        if (textFromGemini && textFromGemini.trim().length > 0) {
          const geminiTextLength = textFromGemini.trim().length;
          this.logger.log(
            `[PDF Extraction] ✓ SUCCESS: Gemini Vision extracted ${geminiTextLength} characters from PDF`,
          );

          // Log a sample of the extracted text
          const sample = textFromGemini.trim().substring(0, 300);
          this.logger.debug(
            `[PDF Extraction] Sample of Gemini-extracted text (first 300 chars): ${sample}...`,
          );

          // Merge with any text from pdf-parse (in case PDF has both text and images)
          const mergedText = textFromPdfParse
            ? `${textFromPdfParse}\n\n${textFromGemini}`
            : textFromGemini;

          const mergedLength = mergedText.trim().length;
          this.logger.log(
            `[PDF Extraction] ✓ FINAL SUCCESS: Combined extraction result (${mergedLength} total characters: ${textFromPdfParse.trim().length} from pdf-parse + ${geminiTextLength} from Gemini Vision)`,
          );
          return mergedText;
        } else {
          this.logger.error(
            '[PDF Extraction] ✗ ERROR: Gemini Vision extraction returned empty text. This may indicate:',
            '1. The PDF images are unreadable',
            '2. The PDF contains no text',
            '3. The API call succeeded but returned no content',
          );
        }
      } catch (visionError: any) {
        const errorType = visionError.constructor?.name || 'Error';
        this.logger.error(
          `[PDF Extraction] ✗ ERROR: Gemini Vision fallback FAILED. Error type: ${errorType}, Message: ${visionError.message}`,
        );
        this.logger.error(
          `[PDF Extraction] Error stack: ${visionError.stack || 'No stack trace available'}`,
        );

        // If we have some text from pdf-parse, return it even if it's minimal
        if (textFromPdfParse && textFromPdfParse.trim().length > 0) {
          this.logger.warn(
            `[PDF Extraction] ⚠ FALLBACK: Returning minimal text from pdf-parse (${textFromPdfParse.trim().length} characters) despite Vision fallback failure.`,
          );
          return textFromPdfParse;
        }

        // Both methods failed - throw comprehensive error
        this.logger.error(
          `[PDF Extraction] ✗ COMPLETE FAILURE: Both pdf-parse and Gemini Vision failed. pdf-parse: ${textFromPdfParse ? 'minimal text' : 'failed'}, Gemini Vision: ${visionError.message}`,
        );
        throw new BadRequestException(
          `Failed to extract text from PDF file. ` +
            `pdf-parse error: ${textFromPdfParse ? 'minimal text extracted' : 'failed'}. ` +
            `Gemini Vision error: ${visionError.message}. ` +
            `Please ensure the file is a valid PDF document with readable text or images.`,
        );
      }
    } else {
      this.logger.warn(
        '[PDF Extraction] ⚠ WARNING: Gemini Vision fallback is DISABLED. Cannot process image-based PDFs.',
      );
    }

    // Vision fallback disabled or both methods failed
    if (textFromPdfParse && textFromPdfParse.trim().length > 0) {
      // Return whatever we got, even if minimal
      this.logger.warn(
        `[PDF Extraction] ⚠ FALLBACK: Returning minimal text from pdf-parse (${textFromPdfParse.trim().length} characters). ` +
          `Consider enabling Gemini Vision fallback (ENABLE_GEMINI_VISION_FALLBACK=true) for better results with image-based PDFs.`,
      );
      return textFromPdfParse;
    }

    // Complete failure
    this.logger.error(
      `[PDF Extraction] ✗ COMPLETE FAILURE: Unable to extract any text from PDF. ` +
        `pdf-parse: ${textFromPdfParse ? 'minimal text' : 'failed'}, ` +
        `Vision fallback: ${enableVisionFallback ? 'attempted but failed' : 'disabled'}`,
    );
    throw new BadRequestException(
      `Failed to extract text from PDF file. ` +
        `The PDF appears to be image-based or corrupted. ` +
        `${enableVisionFallback ? 'Both pdf-parse and Gemini Vision failed.' : 'Enable ENABLE_GEMINI_VISION_FALLBACK for image-based PDF support.'} ` +
        `Please ensure the file is a valid PDF document.`,
    );
  }

  /**
   * Extract text from PDF using Gemini Vision API
   * Handles image-based PDFs and watermarked documents
   */
  private async extractTextFromPdfUsingGeminiVision(
    filePath: string,
    userId?: string,
  ): Promise<string> {
    if (!this.geminiService) {
      throw new Error('Gemini service is not available');
    }

    // Delegate to GeminiService which has the provider access
    return await this.geminiSemaphore.withSlot(() =>
      this.geminiService.extractTextFromPdf(filePath, userId),
    );
  }

  /**
   * Check if content is binary
   */
  private isBinaryContent(content: string): boolean {
    if (!content || content.length === 0) {
      return false;
    }

    const firstBytes = content.substring(0, 100);
    const isZipFile =
      firstBytes.startsWith('PK') ||
      firstBytes.includes('word/') ||
      firstBytes.includes('_rels/');

    const sampleSize = Math.min(content.length, 1000);
    const sample = content.substring(0, sampleSize);
    const nonPrintableCount = (sample.match(/[^\x20-\x7E\n\r\t]/g) || [])
      .length;
    const nonPrintableRatio = nonPrintableCount / sampleSize;

    return isZipFile || nonPrintableRatio > 0.3;
  }

  /**
   * Validate that the content is a script document
   * More flexible validation that accepts various script formats
   * Also handles binary files (like .docx) by detecting and skipping validation
   */
  private isScriptDocument(content: string): boolean {
    if (!content || content.trim().length === 0) {
      return false;
    }

    // Detect binary content (ZIP files, Word documents, etc.)
    // Check for ZIP file signature (PK header) or high percentage of non-printable characters
    const firstBytes = content.substring(0, 100);
    const isZipFile =
      firstBytes.startsWith('PK') ||
      firstBytes.includes('word/') ||
      firstBytes.includes('_rels/');

    // Check for high percentage of non-printable/non-ASCII characters
    const sampleSize = Math.min(content.length, 1000);
    const sample = content.substring(0, sampleSize);
    const nonPrintableCount = (sample.match(/[^\x20-\x7E\n\r\t]/g) || [])
      .length;
    const nonPrintableRatio = nonPrintableCount / sampleSize;
    const isLikelyBinary = nonPrintableRatio > 0.3; // More than 30% non-printable

    if (isZipFile || isLikelyBinary) {
      this.logger.warn(
        'Detected binary file (likely .docx, .xlsx, or other compressed format).',
      );
      // Binary files like .docx cannot be processed as plain text
      // They need to be converted to .txt or .pdf first, or we'd need a library to extract text
      throw new BadRequestException(
        'The uploaded file appears to be a binary format (like .docx or .xlsx). ' +
          'Please convert your script to a plain text (.txt) or PDF (.pdf) format before uploading. ' +
          'You can do this by opening the file in your word processor and saving as "Plain Text" or "PDF".',
      );
    }

    // Normalize content - remove extra whitespace for matching
    const normalizedContent = content.trim();
    const first10000 = normalizedContent.substring(0, 10000).toUpperCase();

    // More flexible script indicators with multiple variations
    const scriptIndicators = [
      // Scene headings - various formats
      /^(INT\.|EXT\.|INT\/EXT\.|INTERIOR|EXTERIOR)/im,
      /(INT\.|EXT\.|INT\/EXT\.)\s+[A-Z\s]+-\s+(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING)/i,

      // Script openings/closings
      /FADE\s+IN/i,
      /FADE\s+OUT/i,
      /FADE\s+TO\s+BLACK/i,
      /FADE\s+TO\s+WHITE/i,

      // Transitions
      /\b(CUT\s+TO|DISSOLVE\s+TO|SMASH\s+CUT|MATCH\s+CUT|WIPE\s+TO)/i,

      // Act/Scene markers - more flexible
      /\b(ACT|SCENE)\s+[IVX\d]+/i,
      /\b(ACT|SCENE)\s+[A-Z]+/i,

      // Character names - more flexible patterns
      /^[A-Z][A-Z\s]{2,}$/m, // All caps line (character name)
      /^[A-Z][A-Z\s]+:$/m, // Character name with colon

      // Dialogue indicators
      /^[A-Z][A-Z\s]+\s*$/m, // Line with all caps (potential character)

      // Parentheticals
      /^\([^)]+\)$/m,
      /^\([^)]+\)\s*$/m,

      // Common script formatting
      /\b(CLOSE\s+UP|CLOSEUP|WIDE\s+SHOT|WIDE\s+ANGLE|POV|POINT\s+OF\s+VIEW)/i,

      // Common script terms
      /\b(CONTINUED|CONT'D|CONT\.|V\.O\.|O\.S\.|O\.C\.|OFF\s+SCREEN|OFF\s+CAMERA)/i,

      // Dialogue patterns (quoted text or indented text)
      /^\s{10,}[A-Z]/m, // Indented dialogue (10+ spaces)

      // Scene numbers
      /^SCENE\s+\d+/im,

      // Title page elements
      /\b(TITLE|SCREENPLAY|SCRIPT|WRITTEN\s+BY|DIRECTED\s+BY)/i,
    ];

    // Count matches
    const matches = scriptIndicators.filter((pattern) =>
      pattern.test(first10000),
    );

    // Additional checks for script-like structure
    const lines = normalizedContent.split('\n');
    const hasMultipleLines = lines.length >= 3;

    // Check for dialogue-like patterns (character name followed by text)
    let dialoguePatternCount = 0;
    for (let i = 0; i < Math.min(lines.length - 1, 50); i++) {
      const line = lines[i].trim();
      const nextLine = lines[i + 1]?.trim() || '';

      // Character name (all caps, short) followed by dialogue or action
      if (
        /^[A-Z][A-Z\s]{1,30}$/.test(line) &&
        nextLine.length > 10 &&
        !/^(INT\.|EXT\.|FADE|CUT|DISSOLVE)/i.test(nextLine)
      ) {
        dialoguePatternCount++;
      }
    }

    // More lenient: accept if we have script indicators OR dialogue patterns
    const hasScriptIndicators = matches.length >= 1;
    const hasDialoguePattern = dialoguePatternCount >= 2;
    const hasSceneHeadings = /^(INT\.|EXT\.|INT\/EXT\.)/im.test(first10000);

    // Log detailed validation results
    this.logger.log(
      `[Script Validation] Analyzing content: ${normalizedContent.length} chars, ${lines.length} lines`,
    );
    this.logger.log(
      `[Script Validation] Pattern matches: ${matches.length} script indicators found, ${dialoguePatternCount} dialogue patterns, ${hasSceneHeadings ? 'HAS' : 'NO'} scene headings`,
    );

    // Log which specific patterns matched
    if (matches.length > 0) {
      const matchedPatterns = scriptIndicators
        .map((pattern, index) => {
          if (pattern.test(first10000)) {
            return `Pattern ${index + 1}: ${pattern.toString().substring(0, 50)}...`;
          }
          return null;
        })
        .filter((p) => p !== null);
      this.logger.log(
        `[Script Validation] Matched patterns: ${matchedPatterns.join(', ')}`,
      );
    }

    // Log sample of content for debugging
    const contentSample = normalizedContent.substring(0, 500);
    this.logger.log(
      `[Script Validation] Content sample (first 500 chars):\n${contentSample}...`,
    );

    // Log first 20 lines for structure analysis
    const firstLines = lines.slice(0, 20);
    this.logger.debug(
      `[Script Validation] First 20 lines structure:\n${firstLines.map((line, i) => `${i + 1}: "${line.substring(0, 80)}"`).join('\n')}`,
    );

    // Check validation criteria
    const validationResult =
      hasMultipleLines &&
      (hasScriptIndicators || hasDialoguePattern || hasSceneHeadings);

    this.logger.log(
      `[Script Validation] Validation criteria check:` +
        `\n  - Has multiple lines (>=3): ${hasMultipleLines} (${lines.length} lines)` +
        `\n  - Has script indicators (>=1): ${hasScriptIndicators} (${matches.length} found)` +
        `\n  - Has dialogue patterns (>=2): ${hasDialoguePattern} (${dialoguePatternCount} found)` +
        `\n  - Has scene headings: ${hasSceneHeadings}` +
        `\n  - FINAL RESULT: ${validationResult ? '✓ VALID' : '✗ INVALID'}`,
    );

    // Accept if:
    // 1. Has at least 1 script indicator, OR
    // 2. Has dialogue patterns (character + text), OR
    // 3. Has scene headings (most reliable indicator)
    // AND has multiple lines (not just a single paragraph)
    return validationResult;
  }

  /**
   * Detect if extracted text is mostly watermarks/tracking codes
   * Returns true if the text appears to be only watermarks without actual content
   */
  private isWatermarkOnly(content: string): boolean {
    if (!content || content.trim().length === 0) {
      return false;
    }

    const normalizedContent = content.trim();
    const sampleSize = Math.min(normalizedContent.length, 2000);
    const sample = normalizedContent.substring(0, sampleSize);

    this.logger.debug(
      `[PDF Extraction] Checking for watermarks in extracted text (sample: ${sampleSize} chars)`,
    );

    // Watermark patterns to detect:
    // 1. Repeated tracking codes (e.g., "67914 - Jan 12, 2026 9:30 AM -")
    // 2. Repeated alphanumeric codes (e.g., "C023J-C023J-C023J-")
    // 3. Date/time stamps repeated
    // 4. Very high repetition of short strings

    // Check for high repetition of short patterns (watermark indicator)
    const lines = sample.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return false;
    }

    // Check if most lines are very similar (watermark pattern)
    const uniqueLines = new Set(lines.map((line) => line.trim()));
    const uniqueRatio = uniqueLines.size / lines.length;

    this.logger.log(
      `[PDF Extraction] Watermark check: ${uniqueLines.size} unique lines out of ${lines.length} total (ratio: ${uniqueRatio.toFixed(2)})`,
    );

    // Log sample of unique lines for debugging
    if (uniqueLines.size <= 5) {
      const uniqueLinesArray = Array.from(uniqueLines);
      this.logger.log(
        `[PDF Extraction] Unique lines sample: ${uniqueLinesArray.map((line, i) => `${i + 1}: "${line.substring(0, 80)}"`).join(', ')}`,
      );
    }

    // If very few unique lines compared to total lines, likely watermarks
    // Lowered threshold from 0.3 to 0.4 to be more aggressive
    if (lines.length > 3 && uniqueRatio < 0.4) {
      this.logger.log(
        `[PDF Extraction] ✓ Watermark detected: High line repetition (${uniqueRatio.toFixed(2)} unique ratio, threshold: 0.4)`,
      );
      return true;
    }

    // Check for common watermark patterns
    const watermarkPatterns = [
      // Date/time stamps repeated (e.g., "67914 - Jan 12, 2026 9:30 AM - 67914")
      /\d{4,6}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M\s*-\s*\d{4,6}/g,
      // Alphanumeric codes repeated (e.g., C023J-C023J-C023J-)
      /([A-Z0-9]{3,10}-){5,}/g,
      // Repeated short strings with dashes (3-10 chars repeated many times)
      /(.{3,10}\s*-\s*){10,}/g,
      // Pattern: number - date - number (watermark format)
      /\d{4,6}\s*-\s*[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M/g,
    ];

    let watermarkMatches = 0;
    for (const pattern of watermarkPatterns) {
      const matches = sample.match(pattern);
      if (matches && matches.length > 0) {
        watermarkMatches += matches.length;
        this.logger.debug(
          `[PDF Extraction] Found ${matches.length} matches for pattern: ${pattern.toString().substring(0, 50)}...`,
        );
      }
    }

    // If we find many watermark pattern matches, likely watermarks
    if (watermarkMatches > 5) {
      this.logger.log(
        `[PDF Extraction] ✓ Watermark detected: Found ${watermarkMatches} watermark pattern matches`,
      );
      return true;
    }

    // Check if content is mostly repetitive short strings
    const words = sample.split(/\s+/).filter((w) => w.length > 0);
    if (words.length > 20) {
      const uniqueWords = new Set(words);
      const wordRepetitionRatio = uniqueWords.size / words.length;

      this.logger.debug(
        `[PDF Extraction] Watermark check: ${uniqueWords.size} unique words out of ${words.length} total (ratio: ${wordRepetitionRatio.toFixed(2)})`,
      );

      // If very few unique words, likely watermarks
      if (wordRepetitionRatio < 0.2) {
        this.logger.log(
          `[PDF Extraction] ✓ Watermark detected: High word repetition (${wordRepetitionRatio.toFixed(2)} unique ratio)`,
        );
        return true;
      }
    }

    this.logger.debug(
      '[PDF Extraction] No watermarks detected - text appears to be legitimate content',
    );
    return false;
  }

  /**
   * Analyze a pre-parsed script using clean_text from the Python script_parser service.
   * Called by AiServiceService.analyzeFromParseResult() in the new task 4.0.26 code path.
   *
   * Skips download and extraction; Gemini receives the clean, structured text
   * produced by the Python parser (watermark-free, properly indented, no page noise).
   *
   * parsedScenes and parsedCharacters from Python are used as the structural seed
   * (equivalent to FDX parse data), and Gemini enriches them semantically.
   */
  async analyzeScriptFromCleanText(
    parseResult: ScriptParserResultPayload,
    nativeExtraction: ScriptParserNativeExtractionPayload | null,
    scriptName: string,
    taskId: string,
    userId: string,
    projectId: string,
    onProgress?: (progress: number, message: string, step?: string) => void,
  ): Promise<{
    scriptId: string;
    characters: Array<{ id: string; name: string }>;
    scenes: Array<{ id: string; number: number }>;
    analysisResult: ScriptAnalysisResult;
    analysisLifecycle: AnalysisLifecycleMetadata;
  }> {
    this.setPendingAnalysisPathMetadata({
      structuralPath: 'python_script_parser',
      semanticPath: 'gemini_scene_semantic',
    });
    this.logger.log(
      `[AnalysisRouting] ${JSON.stringify({
        taskId,
        projectId,
        routePattern: 'ai.script-analysis',
        structuralPath: 'python_script_parser',
        semanticPath: 'gemini_scene_semantic',
      })}`,
    );
    this.logger.log(
      `[ParserFirst] Parse result summary ${JSON.stringify({
        taskId,
        projectId,
        scriptName,
        format: parseResult.format,
        pageCount: parseResult.page_count,
        sceneCount: parseResult.scenes?.length || 0,
        characterCount: parseResult.characters?.length || 0,
        cleanTextLength: parseResult.clean_text?.length || 0,
        rawTextLength: parseResult.raw_text?.length || 0,
        structureConfidenceScore: parseResult.structure_confidence_score,
        watermarkDetected: parseResult.watermark_detected,
        watermarkTexts: parseResult.watermark_texts || [],
        parserWarnings: parseResult.parser_warnings || [],
        lowConfidenceFlag: parseResult.low_confidence_flag,
        stagePlayDetected: parseResult.stage_play_detected,
        documentClass: (parseResult as any).document_class || null,
      })}`,
    );
    if (parseResult.clean_text?.trim()) {
      this.logger.log(
        `[ParserFirst] Clean text sample (first 500 chars):\n${parseResult.clean_text.slice(0, 500)}`,
      );
    }
    const nativeBridgeDecision = this.shouldUseParserNativeExtractionBridge(
      nativeExtraction,
      {
        taskId,
        scriptName,
      },
    );
    this.pendingExtractionPathMetadata = {
      ...(this.pendingExtractionPathMetadata || {}),
      pymupdfNativeBridgeEnabled: nativeBridgeDecision.enabled,
      pymupdfNativeBridgeRollout: nativeBridgeDecision.rollout,
      pymupdfNativeBridgeRolloutMatched: nativeBridgeDecision.rolloutMatched,
      pymupdfNativeBridgeUsed: nativeBridgeDecision.allowed,
      pymupdfNativeBridgeReason: nativeBridgeDecision.reason,
    };
    this.logger.log(
      `[ParserFirst] PyMuPDF bridge decision ${JSON.stringify({
        taskId,
        projectId,
        scriptName,
        enabled: nativeBridgeDecision.enabled,
        rollout: nativeBridgeDecision.rollout,
        rolloutMatched: nativeBridgeDecision.rolloutMatched,
        allowed: nativeBridgeDecision.allowed,
        reason: nativeBridgeDecision.reason,
      })}`,
    );
    if (nativeBridgeDecision.allowed && nativeExtraction?.blocks?.length) {
      this.consumeParserNativeExtraction(nativeExtraction, {
        taskId,
        projectId,
        scriptName,
      });
    }
    onProgress?.(
      35,
      'Running AI semantic analysis on parsed script…',
      'analysis',
    );

    // Convert Python parser output to FdxParseResult shape so saveScriptToDatabase
    // can use the deterministic structure for DB seeding
    const fdxData: FdxParseResult = {
      title: scriptName,
      scenes: parseResult.scenes.map((s) => ({
        number: s.number,
        heading: s.heading,
        characters: s.elements
          .filter((el) => el.type === 'character' && el.character_name)
          .map((el) => el.character_name as string),
        elements: s.elements
          .filter((el) =>
            ['dialogue', 'action', 'parenthetical'].includes(el.type),
          )
          .map((el) => ({
            type: el.type as FdxSceneElement['type'],
            text: el.text,
            characterName: el.character_name || null,
            lines: [el.text],
            page: s.page_start ?? null,
          })),
        page: s.page_start ?? null,
        pages:
          s.page_start && s.page_end && s.page_end >= s.page_start
            ? Array.from(
                { length: s.page_end - s.page_start + 1 },
                (_, index) => s.page_start + index,
              )
            : s.page_start
              ? [s.page_start]
              : [],
      })),
      characters: parseResult.characters.map((c) => c.name),
      rawText: parseResult.clean_text,
    };

    // Diagnostic: log page data from parser scenes vs fdxData conversion
    const sampleScenes = parseResult.scenes.slice(0, 3).map((s, i) => ({
      scene: s.number,
      parser_page_start: s.page_start,
      parser_page_end: s.page_end,
      fdx_pages: fdxData.scenes[i]?.pages,
    }));
    this.logger.log(
      `[ParserFirst] Page tracking diagnostic: ${JSON.stringify(sampleScenes)}`,
    );

    const { analysisResult, semanticMetadata } =
      await this.geminiSemaphore.withSlot(() =>
        this.geminiService.analyzeParsedScript(
          parseResult,
          scriptName,
          onProgress,
          userId,
        ),
      );

    if (semanticMetadata?.synthesisFallbackUsed) {
      this.setPendingAnalysisPathMetadata({
        structuralPath: 'python_script_parser',
        semanticPath: 'gemini_scene_semantic_with_raw_text_fallback',
      });
    }
    this.logger.log(
      `[ParserFirst] Semantic analysis summary ${JSON.stringify({
        taskId,
        projectId,
        semanticStrategy: semanticMetadata?.semanticStrategy || null,
        totalScenes: semanticMetadata?.totalScenes || 0,
        coveredScenes: semanticMetadata?.coveredScenes || 0,
        sceneCoverageRatio: semanticMetadata?.sceneCoverageRatio ?? null,
        totalSemanticUnits: semanticMetadata?.totalSemanticUnits || 0,
        successfulSemanticUnits: semanticMetadata?.successfulSemanticUnits || 0,
        semanticUnitCoverageRatio:
          semanticMetadata?.semanticUnitCoverageRatio ?? null,
        synthesisSucceeded: semanticMetadata?.synthesisSucceeded ?? null,
        synthesisFallbackUsed: semanticMetadata?.synthesisFallbackUsed ?? false,
        synthesizedGlobalFieldCount:
          semanticMetadata?.synthesizedGlobalFieldCount ?? 0,
        qualityGate: semanticMetadata?.qualityGate || null,
      })}`,
    );

    // Pass parser scenes directly to DB — no consolidation.
    // The parser's structural scene boundaries are authoritative.
    const consolidatedFdxData = fdxData;
    const consolidatedAnalysis = analysisResult;

    onProgress?.(80, 'Saving script data to database…', 'saving');

    const savedData = await this.saveScriptToDatabase(
      consolidatedAnalysis,
      '',
      userId,
      scriptName,
      scriptName,
      taskId,
      projectId,
      onProgress,
      consolidatedFdxData,
      parseResult,
      semanticMetadata,
    );

    return {
      scriptId: savedData.scriptId,
      characters: savedData.characters,
      scenes: savedData.scenes,
      analysisResult,
      analysisLifecycle: savedData.analysisLifecycle,
    };
  }

  /**
   * Consolidate many structural scenes into fewer narrative scenes
   * by grouping consecutive scenes at the same location.
   */
  private consolidateScenesForDatabase(
    fdxData: FdxParseResult,
    analysisResult: ScriptAnalysisResult,
    parseResult: ScriptParserResultPayload,
  ): {
    consolidatedFdxData: FdxParseResult;
    consolidatedAnalysis: ScriptAnalysisResult;
  } {
    const units = this.geminiService.buildConsolidationUnits(
      parseResult.scenes,
    );

    if (units.length === 0 || units.length === fdxData.scenes.length) {
      this.logger.log(
        `[Consolidation] No consolidation needed (${fdxData.scenes.length} scenes)`,
      );
      return {
        consolidatedFdxData: fdxData,
        consolidatedAnalysis: analysisResult,
      };
    }

    // Build lookup maps keyed by scene number
    const fdxSceneLookup = new Map<number, FdxScene>();
    for (const s of fdxData.scenes) {
      fdxSceneLookup.set(s.number, s);
    }
    const analysisSceneLookup = new Map<
      number,
      (typeof analysisResult.scenes)[0]
    >();
    for (const s of analysisResult.scenes) {
      analysisSceneLookup.set(s.number, s);
    }

    const consolidatedFdxScenes: FdxScene[] = [];
    const consolidatedAnalysisScenes: (typeof analysisResult.scenes)[0][] = [];

    for (let unitIdx = 0; unitIdx < units.length; unitIdx++) {
      const unit = units[unitIdx];
      const sceneNumbers = unit.scenes.map((s) => s.number);

      // Merge FDX scenes
      const fdxScenes = sceneNumbers
        .map((n) => fdxSceneLookup.get(n))
        .filter(Boolean) as FdxScene[];

      if (fdxScenes.length > 0) {
        const mergedElements: FdxSceneElement[] = [];
        const mergedCharacters = new Set<string>();
        const mergedPages = new Set<number>();

        for (const fs of fdxScenes) {
          mergedElements.push(...fs.elements);
          for (const c of fs.characters) mergedCharacters.add(c);
          if (fs.pages) {
            for (const p of fs.pages) mergedPages.add(p);
          }
          if (fs.page != null) mergedPages.add(fs.page);
        }

        consolidatedFdxScenes.push({
          number: unitIdx + 1,
          heading: fdxScenes[0].heading,
          elements: mergedElements,
          characters: [...mergedCharacters],
          page: fdxScenes[0].page,
          pages: [...mergedPages].sort((a, b) => a - b),
        });
      }

      // Merge analysis scenes
      const analysisScenes = sceneNumbers
        .map((n) => analysisSceneLookup.get(n))
        .filter(Boolean) as (typeof analysisResult.scenes)[0][];

      if (analysisScenes.length > 0) {
        const mergedSummaries: string[] = [];
        const mergedAnalysisChars = new Set<string>();
        const mergedAnalysisPages = new Set<number>();
        const mergedDialogues: NonNullable<
          (typeof analysisResult.scenes)[0]['dialogues']
        > = [];

        for (const as of analysisScenes) {
          if (as.summary) mergedSummaries.push(as.summary);
          for (const c of as.characters || []) mergedAnalysisChars.add(c);
          for (const p of as.pages || []) mergedAnalysisPages.add(p);
          if (as.dialogues) mergedDialogues.push(...as.dialogues);
        }

        consolidatedAnalysisScenes.push({
          number: unitIdx + 1,
          heading: analysisScenes[0].heading,
          summary: mergedSummaries.join(' '),
          characters: [...mergedAnalysisChars],
          pages: [...mergedAnalysisPages].sort((a, b) => a - b),
          dialogues: mergedDialogues.length > 0 ? mergedDialogues : undefined,
        });
      } else {
        // No analysis scene matched — create a stub
        consolidatedAnalysisScenes.push({
          number: unitIdx + 1,
          heading: unit.scenes[0].heading,
          summary: '',
          characters: [],
          pages: [],
        });
      }
    }

    this.logger.log(
      `[Consolidation] Consolidated ${fdxData.scenes.length} structural scenes into ${consolidatedFdxScenes.length} narrative scenes`,
    );

    return {
      consolidatedFdxData: {
        ...fdxData,
        scenes: consolidatedFdxScenes,
      },
      consolidatedAnalysis: {
        ...analysisResult,
        scenes: consolidatedAnalysisScenes,
      },
    };
  }

  /**
   * Analyze script content using Google Gemini via GeminiService
   */
  private async analyzeWithGemini(
    scriptContent: string,
    title: string,
    onProgress?: (progress: number, message: string, step?: string) => void,
    userId?: string,
  ): Promise<ScriptAnalysisResult> {
    onProgress?.(40, 'Preparing AI analysis...', 'preparation');
    onProgress?.(50, 'Calling AI API...', 'api_call');

    try {
      const result = await this.geminiSemaphore.withSlot(() =>
        this.geminiService.analyzeScript(
          scriptContent,
          title,
          onProgress,
          userId,
        ),
      );

      onProgress(70, 'Validating extracted data...', 'validation');

      return result;
    } catch (error: any) {
      const errorMessage =
        error?.message ||
        error?.toString() ||
        'Unknown error during AI analysis';
      const errorStack = error?.stack || 'No stack trace available';

      this.logger.error(
        `Error analyzing script with Gemini: ${errorMessage}`,
        errorStack,
      );
      throw new BadRequestException(`AI analysis failed: ${errorMessage}`);
    }
  }

  /**
   * Save script, characters, and scenes to database in a transaction
   * Finds existing script by taskId and updates it with analysis results
   */
  private async saveScriptToDatabase(
    analysis: ScriptAnalysisResult,
    fileUrl: string,
    userId: string,
    projectTitle: string | null,
    mediaFileName: string | null,
    taskId: string,
    projectId: string,
    onProgress?: (progress: number, message: string, step?: string) => void,
    fdxData?: FdxParseResult,
    parserResult?: ScriptParserResultPayload,
    semanticMetadata?: Record<string, any>,
  ): Promise<{
    scriptId: string;
    characters: Array<{ id: string; name: string }>;
    scenes: Array<{ id: string; number: number }>;
    analysisLifecycle: AnalysisLifecycleMetadata;
  }> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const scriptRepo = manager.getRepository(Script);
      const characterRepo = manager.getRepository(Character);
      const sceneRepo = manager.getRepository(Scene);

      onProgress?.(82, 'Updating script record...', 'script_creation');

      // Find existing script by taskId
      const existingScript = await scriptRepo.findOne({
        where: { taskId },
      });

      if (!existingScript) {
        throw new BadRequestException(
          `Script with taskId ${taskId} not found. Script must be created before analysis.`,
        );
      }

      // Update script with analysis results (use file name as script name, not project title)
      const scriptTitle =
        mediaFileName ||
        projectTitle ||
        analysis.summary?.substring(0, 100) ||
        existingScript.title ||
        'Untitled Script';

      const parserMetadata = {
        ...(existingScript.parserMetadata || {}),
      } as Record<string, any>;
      if (this.pendingStructuredWarnings?.length) {
        const existingWarnings: string[] = Array.isArray(
          parserMetadata.structuralWarnings,
        )
          ? parserMetadata.structuralWarnings
          : [];
        parserMetadata.structuralWarnings = Array.from(
          new Set([...existingWarnings, ...this.pendingStructuredWarnings]),
        );
        this.pendingStructuredWarnings = null;
      }
      if (this.pendingStructuredNormalization?.structuralFlags) {
        parserMetadata.structuralFlags = {
          ...(parserMetadata.structuralFlags || {}),
          ...this.pendingStructuredNormalization.structuralFlags,
        };
      }
      if (this.extractionAttempts.length) {
        const finalSource = this.getFinalExtractionSource();
        parserMetadata.extractionSource = finalSource;
        parserMetadata.extractionAttempts = this.extractionAttempts;
        this.logExtractionSummary({
          taskId,
          fileName: mediaFileName || undefined,
          finalSource,
        });
        this.extractionAttempts = [];
      }
      if (this.pendingNativePdfCapability) {
        parserMetadata.nativePdfCapability = this.pendingNativePdfCapability;
        this.pendingNativePdfCapability = null;
      }
      if (this.pendingExtractionPathMetadata) {
        parserMetadata.extractionPath = {
          ...(parserMetadata.extractionPath || {}),
          ...this.pendingExtractionPathMetadata,
          finalExtractionSource: parserMetadata.extractionSource || null,
          fallbackUsed:
            this.pendingExtractionPathMetadata.initialExtractionPath !==
            (parserMetadata.extractionSource || null),
          updatedAt: new Date().toISOString(),
        };
        this.pendingExtractionPathMetadata = null;
      }
      if (this.pendingStructuredNormalization?.parsedPages?.length) {
        parserMetadata.parsedPages =
          this.pendingStructuredNormalization.parsedPages;
        parserMetadata.coverageRatio =
          this.pendingStructuredNormalization.coverageRatio;
        parserMetadata.scenePageMap =
          this.pendingStructuredNormalization.fdxResult.scenes.map((scene) => ({
            number: scene.number,
            heading: scene.heading,
            page: scene.page ?? null,
          }));
      }
      this.pendingStructuredNormalization = null;

      if (parserResult) {
        const parserResultMetadata =
          this.buildParserMetadataFromParseResult(parserResult);
        Object.assign(parserMetadata, parserResultMetadata);
      }
      if (this.pendingNativePdfWatermarkSuppression) {
        parserMetadata.watermarkDetected = Boolean(
          parserMetadata.watermarkDetected ||
            this.pendingNativePdfWatermarkSuppression.watermarkDetected,
        );
        parserMetadata.watermarkTexts = Array.from(
          new Set([
            ...(Array.isArray(parserMetadata.watermarkTexts)
              ? parserMetadata.watermarkTexts
              : []),
            ...((this.pendingNativePdfWatermarkSuppression.watermarkTexts ||
              []) as string[]),
          ]),
        );
        parserMetadata.watermarkSuppression = {
          ...(parserMetadata.watermarkSuppression || {}),
          ...this.pendingNativePdfWatermarkSuppression,
        };
        this.pendingNativePdfWatermarkSuppression = null;
      }
      if (this.pendingParserNativeExtraction) {
        parserMetadata.nativeExtraction = {
          ...(parserMetadata.nativeExtraction || {}),
          ...this.pendingParserNativeExtraction,
        };
        this.pendingParserNativeExtraction = null;
      }
      if (semanticMetadata) {
        parserMetadata.semanticAnalysis = {
          ...(parserMetadata.semanticAnalysis || {}),
          ...semanticMetadata,
          updatedAt: new Date().toISOString(),
        };
      }

      const analysisPathMetadata: Record<string, any> = {
        ...(this.pendingAnalysisPathMetadata || {
          pathVersion: 'phase0-baseline',
          routePattern: 'ai.script-analysis',
          structuralPath: 'direct_extraction',
          semanticPath: 'gemini_raw_text_semantic',
          parserFirstEnabled: this.configService.get<boolean>(
            'ENABLE_PARSER_FIRST_ANALYSIS',
            false,
          ),
          parserFirstRollout: this.configService.get<number>(
            'PARSER_FIRST_ANALYSIS_ROLLOUT',
            0,
          ),
          legacyAiAnalyzePathActive: false,
          updatedAt: new Date().toISOString(),
        }),
      };

      if (
        fdxData &&
        analysisPathMetadata.structuralPath === 'direct_extraction'
      ) {
        analysisPathMetadata.structuralPath =
          'direct_extraction_with_deterministic_structure_seed';
      }

      analysisPathMetadata.extractionSource =
        parserMetadata.extractionSource || null;
      parserMetadata.degradedInputClassification =
        this.buildDegradedInputClassificationMetadata({
          parserMetadata,
          semanticMetadata,
          analysis,
        });
      const degradedInputClassification =
        parserMetadata.degradedInputClassification;
      if (degradedInputClassification?.decision === 'unsupported_degraded') {
        this.pendingAnalysisPathMetadata = null;
        this.logger.warn(
          `[DegradedInput] Rejected unsupported degraded script ${JSON.stringify(
            {
              taskId,
              scriptId: existingScript.id,
              title: scriptTitle,
              decision: degradedInputClassification.decision,
              fileClass: degradedInputClassification.fileClass,
              reasons: degradedInputClassification.reasons,
              warnings: degradedInputClassification.warnings,
              analysisPath: analysisPathMetadata,
            },
          )}`,
        );
        throw new UnsupportedDegradedScriptError({
          message:
            'We couldn’t analyze this script reliably because the file is too visually degraded or heavily marked up. Please upload a cleaner PDF or original script export.',
          structuralPath: analysisPathMetadata.structuralPath,
          semanticPath: analysisPathMetadata.semanticPath,
          extractionSource: parserMetadata.extractionSource || null,
          degradedInputClassification,
        });
      }
      parserMetadata.analysisPath = analysisPathMetadata;
      const analysisLifecycleMetadata =
        this.buildSuccessAnalysisLifecycleMetadata({
          extractionSource: parserMetadata.extractionSource || null,
          analysisPath: analysisPathMetadata as AnalysisPathMetadata,
          semanticMetadata,
        });
      parserMetadata.analysisLifecycle = analysisLifecycleMetadata;
      this.pendingAnalysisPathMetadata = null;
      this.logger.log(
        `[AnalysisRouting] Persisted ${JSON.stringify({
          taskId,
          scriptId: existingScript.id,
          analysisPath: parserMetadata.analysisPath,
        })}`,
      );
      this.logger.log(
        `[ParserFirst] Persisting analysis artifacts ${JSON.stringify({
          taskId,
          scriptId: existingScript.id,
          title: scriptTitle,
          parserFormat: parserMetadata.parserFormat || null,
          extractionSource: parserMetadata.extractionSource || null,
          pageCount: parserMetadata.pageCount || null,
          coverageRatio: parserMetadata.coverageRatio ?? null,
          parserWarnings: parserMetadata.parserWarnings || [],
          structuralWarnings: parserMetadata.structuralWarnings || [],
          semanticWarnings:
            parserMetadata.semanticAnalysis?.qualityGate?.reasons || [],
          degradedInputClassification:
            parserMetadata.degradedInputClassification || null,
          semanticLifecycle: parserMetadata.analysisLifecycle || null,
        })}`,
      );

      existingScript.parserMetadata = parserMetadata;
      existingScript.title = scriptTitle;
      existingScript.status = ScriptStatus.ANALYZED;
      const savedScript = await scriptRepo.save(existingScript);

      onProgress?.(85, 'Saving characters...', 'character_creation');

      // Clean up old scenes and characters from any previous analysis run.
      // Scenes must be deleted first to clear character_scenes join table entries.
      // Rehearsals referencing old characters have onDelete: SET NULL, so their
      // characterId is automatically nulled (user re-selects role after re-analysis).
      const existingScenes = await sceneRepo.find({
        where: { scriptId: savedScript.id },
      });
      if (existingScenes.length > 0) {
        await sceneRepo.remove(existingScenes);
        this.logger.log(
          `Removed ${existingScenes.length} existing scene(s) for script ${savedScript.id} before re-analysis`,
        );
      }
      const existingCharacters = await characterRepo.find({
        where: { scriptId: savedScript.id },
      });
      if (existingCharacters.length > 0) {
        await characterRepo.remove(existingCharacters);
        this.logger.log(
          `Removed ${existingCharacters.length} existing character(s) for script ${savedScript.id} before re-analysis`,
        );
      }

      // Create characters and map names to Character entities.
      // When FDX data is available, merge: FDX provides the authoritative character list,
      // Gemini provides the deeper analysis fields (description, arc, etc.).
      const characterMap = new Map<string, Character>();

      // Build a lookup from Gemini analysis for enriching FDX characters
      const geminiCharLookup = new Map<
        string,
        (typeof analysis.characters)[0]
      >();
      for (const c of analysis.characters) {
        geminiCharLookup.set(c.name.toUpperCase(), c);
      }

      // Determine authoritative character list: FDX if available, else Gemini
      const characterNames = fdxData
        ? fdxData.characters
        : analysis.characters.map((c) => c.name);

      for (const name of characterNames) {
        const geminiChar = geminiCharLookup.get(name.toUpperCase());
        const character = characterRepo.create({
          scriptId: savedScript.id,
          name,
          description: geminiChar?.description || null,
          background: geminiChar?.background || null,
          definingPersonalityTraits:
            geminiChar?.definingPersonalityTraits || null,
          perception: geminiChar?.perception || null,
          goalAndConflict: geminiChar?.goalAndConflict || null,
          emotionalArc: geminiChar?.emotionalArc || null,
          relationships: geminiChar?.relationships || null,
          subtextAndCoreTruth: geminiChar?.subtextAndCoreTruth || null,
          voiceProfile: geminiChar?.voiceProfile ?? null,
        });
        const savedChar = await characterRepo.save(character);
        characterMap.set(name, savedChar);
        // Also map uppercase for FDX lookups
        characterMap.set(name.toUpperCase(), savedChar);
        this.logger.debug(
          `Created character: ${savedChar.name} (ID: ${savedChar.id})`,
        );
      }

      onProgress?.(
        92,
        'Saving scenes with character mappings...',
        'scene_creation',
      );

      // Create scenes with character relationships and dialogues.
      // When FDX data is available, use it for scene structure (headings, dialogues, characters).
      // Gemini scene data is used for summaries and page estimates.
      const savedScenes: Scene[] = [];

      // Build a Gemini scene lookup by number for enriching FDX scenes
      const geminiSceneLookup = new Map<number, (typeof analysis.scenes)[0]>();
      for (const s of analysis.scenes) {
        geminiSceneLookup.set(s.number, s);
      }

      const sceneSources = fdxData
        ? fdxData.scenes.map((fdxScene) => {
            const geminiScene = geminiSceneLookup.get(fdxScene.number);
            return {
              number: fdxScene.number,
              heading: fdxScene.heading,
              summary: geminiScene?.summary || null,
              pages:
                (Array.isArray(fdxScene.pages) && fdxScene.pages.length
                  ? fdxScene.pages
                  : geminiScene?.pages) || [],
              characters: fdxScene.characters,
              dialogues: fdxScene.elements.map((el) => ({
                type: el.type,
                characterName: el.characterName,
                characterId:
                  (el.characterName
                    ? (characterMap.get(el.characterName)?.id ??
                      characterMap.get(el.characterName?.toUpperCase())?.id)
                    : null) ?? null,
                lines: el.lines,
                page: el.page ?? null,
              })),
            };
          })
        : analysis.scenes.map((sceneData) => ({
            number: sceneData.number,
            heading: sceneData.heading,
            summary: sceneData.summary,
            pages: sceneData.pages,
            characters: sceneData.characters || [],
            dialogues: Array.isArray((sceneData as any).dialogues)
              ? (
                  (sceneData as any).dialogues as Array<{
                    type?: string;
                    character?: string | null;
                    text: string;
                  }>
                )
                  .filter((d) => d && d.text != null)
                  .map((d) => {
                    const elementType = (
                      ['dialogue', 'action', 'parenthetical'].includes(d.type)
                        ? d.type
                        : 'dialogue'
                    ) as 'dialogue' | 'action' | 'parenthetical';
                    const name = d.character?.trim() || null;
                    const charEntity = name
                      ? characterMap.get(name) ||
                        characterMap.get(name.toUpperCase())
                      : undefined;
                    return {
                      type: elementType,
                      characterName: name,
                      characterId: charEntity?.id ?? null,
                      lines: [
                        typeof d.text === 'string'
                          ? d.text.trim()
                          : String(d.text).trim(),
                      ],
                    };
                  })
              : [],
          }));

      for (const sceneData of sceneSources) {
        // Collect Character entities for this scene
        const sceneCharacters: Character[] = [];
        for (const charName of sceneData.characters) {
          const characterEntity =
            characterMap.get(charName) ||
            characterMap.get(charName.toUpperCase());
          if (characterEntity) {
            sceneCharacters.push(characterEntity);
          } else {
            this.logger.warn(
              `Character "${charName}" not found in character map for scene ${sceneData.number}`,
            );
          }
        }

        const sceneDialogues: Scene['dialogues'] =
          sceneData.dialogues.length > 0 ? sceneData.dialogues : null;

        // Create scene first without characters
        if (sceneData.number <= 3) {
          this.logger.log(
            `[SaveScene] Scene ${sceneData.number} pages=${JSON.stringify(sceneData.pages)}`,
          );
        }
        const scene = sceneRepo.create({
          scriptId: savedScript.id,
          number: sceneData.number,
          heading: sceneData.heading,
          summary: sceneData.summary,
          pages: sceneData.pages.length > 0 ? sceneData.pages : null,
          dialogues: sceneDialogues,
        });

        // Save scene first to get the ID
        const savedScene = await sceneRepo.save(scene);

        // Now assign characters and save again to create the ManyToMany relationship
        // Only assign characters that have valid IDs (were successfully saved).
        // Deduplicate by ID — Gemini returns a character element for every
        // dialogue block, so the same character can appear multiple times in
        // sceneData.characters, causing duplicate key errors on character_scenes.
        const seenIds = new Set<string>();
        const validCharacters = sceneCharacters.filter((char) => {
          if (!char.id) {
            this.logger.warn(
              `Character "${char.name}" does not have an ID, skipping scene relationship`,
            );
            return false;
          }
          if (seenIds.has(char.id)) return false;
          seenIds.add(char.id);
          return true;
        });

        if (validCharacters.length > 0) {
          // Preserve dialogues when updating characters relationship
          savedScene.characters = validCharacters;
          savedScene.dialogues = sceneDialogues; // Ensure dialogues are preserved (sequential order)
          await sceneRepo.save(savedScene);
          this.logger.debug(
            `Linked ${validCharacters.length} character(s) to scene ${sceneData.number}`,
          );
        } else if (sceneCharacters.length > 0) {
          this.logger.warn(
            `No valid characters to link to scene ${sceneData.number} (${sceneCharacters.length} characters were provided but none have IDs)`,
          );
        }

        // Reload scene with characters to ensure relationships are properly loaded
        const sceneWithCharacters = await sceneRepo.findOne({
          where: { id: savedScene.id },
          relations: ['characters'],
        });

        if (sceneWithCharacters) {
          savedScenes.push(sceneWithCharacters);
          this.logger.log(
            `Scene ${sceneData.number} saved with ${sceneWithCharacters.characters?.length || 0} character(s) mapped: ${sceneWithCharacters.characters?.map((c) => c.name).join(', ') || 'none'}`,
          );
        } else {
          savedScenes.push(savedScene);
        }
      }

      onProgress?.(98, 'Finalizing database entries...', 'finalization');
      this.logger.log(
        `[ParserFirst] Save complete ${JSON.stringify({
          taskId,
          scriptId: savedScript.id,
          savedCharacterCount: characterNames.length,
          savedSceneCount: savedScenes.length,
          finalStatus: savedScript.status,
        })}`,
      );

      return {
        scriptId: savedScript.id,
        characters: Array.from(characterMap.entries()).map(([name, char]) => ({
          id: char.id,
          name,
        })),
        scenes: savedScenes.map((s) => ({
          id: s.id,
          number: s.number,
        })),
        analysisLifecycle: analysisLifecycleMetadata,
      };
    });
  }

  private buildDegradedInputClassificationMetadata(options: {
    parserMetadata: Record<string, any>;
    semanticMetadata?: Record<string, any>;
    analysis: ScriptAnalysisResult;
  }) {
    const parserMetadata = options.parserMetadata || {};
    const semanticMetadata =
      options.semanticMetadata || parserMetadata.semanticAnalysis || {};
    const qualityGate = semanticMetadata.qualityGate || {};
    const scenePageMap = Array.isArray(parserMetadata.scenePageMap)
      ? parserMetadata.scenePageMap
      : [];
    const characterLineCounts = Array.isArray(
      parserMetadata.characterLineCounts,
    )
      ? parserMetadata.characterLineCounts
      : [];

    return classifyDegradedInput({
      pageCount:
        typeof parserMetadata.pageCount === 'number'
          ? parserMetadata.pageCount
          : null,
      parsedPageCount:
        typeof parserMetadata.parsedPageCount === 'number'
          ? parserMetadata.parsedPageCount
          : null,
      pageCoverageRatio:
        typeof parserMetadata.pageCoverageRatio === 'number'
          ? parserMetadata.pageCoverageRatio
          : typeof parserMetadata.coverageRatio === 'number'
            ? parserMetadata.coverageRatio
            : null,
      sceneCount:
        typeof parserMetadata.sceneCount === 'number'
          ? parserMetadata.sceneCount
          : Array.isArray(options.analysis.scenes)
            ? options.analysis.scenes.length
            : null,
      sceneHeadings: scenePageMap
        .map((scene: Record<string, any>) =>
          typeof scene.heading === 'string' ? scene.heading : null,
        )
        .filter((heading: string | null): heading is string =>
          Boolean(heading),
        ),
      structureConfidenceScore:
        typeof parserMetadata.structureConfidenceScore === 'number'
          ? parserMetadata.structureConfidenceScore
          : null,
      lowConfidenceFlag: Boolean(parserMetadata.lowConfidenceFlag),
      watermarkDetected: Boolean(parserMetadata.watermarkDetected),
      structuralWarnings: Array.isArray(parserMetadata.structuralWarnings)
        ? parserMetadata.structuralWarnings
        : [],
      structuralClassificationWarnings: Array.isArray(
        parserMetadata.structuralClassificationWarnings,
      )
        ? parserMetadata.structuralClassificationWarnings
        : [],
      qualityGatePassed:
        typeof qualityGate.passed === 'boolean' ? qualityGate.passed : null,
      qualityGateReasons: Array.isArray(qualityGate.reasons)
        ? qualityGate.reasons
        : [],
      fallbackUsed: Boolean(semanticMetadata.synthesisFallbackUsed),
      characterLineCounts,
      analysisCharacterNames: Array.isArray(options.analysis.characters)
        ? options.analysis.characters
            .map((character) => character?.name)
            .filter((name): name is string => typeof name === 'string')
        : [],
    });
  }
}
