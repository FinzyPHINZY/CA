/** biome-ignore-all lint/correctness/noUnusedImports: <> */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { HumanMessage } from '@langchain/core/messages';
import { UsageRecordRepository, UsageService } from '@app/common';
import { GeminiProvider } from './providers/gemini.provider';
import { withGeminiRetry } from '../gemini-retry.util';
import { extractTotalTokensFromLangChainInvokeResult } from './gemini-langchain-usage.util';
import {
  ScriptParserElement,
  ScriptParserResultPayload,
  ScriptParserScene,
} from '../../../contracts/script-parser.contract';

// Comprehensive Zod schema matching expected output structure
export const ScriptAnalysisSchema = z.object({
  summary: z.string(),
  characters: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      background: z.string().optional(),
      definingPersonalityTraits: z.string().optional(),
      perception: z.string().optional(),
      goalAndConflict: z.string().optional(),
      emotionalArc: z.string().optional(),
      relationships: z.string().optional(),
      subtextAndCoreTruth: z.string().optional(),
      voiceProfile: z
        .object({
          gender: z.enum(['male', 'female', 'neutral']).optional().catch(undefined),
          ageCategory: z.enum(['young', 'middle', 'old']).optional().catch(undefined),
          accent: z.string().optional(),
        })
        .optional()
        .catch(undefined),
    }),
  ),
  scenes: z.array(
    z.object({
      number: z.number(),
      heading: z.string(),
      summary: z.string(),
      pages: z.array(z.number()),
      characters: z.array(z.string()),
      // scene elements in script order: dialogue, action lines, and parentheticals
      dialogues: z
        .array(
          z.object({
            type: z
              .enum(['dialogue', 'action', 'parenthetical'])
              .default('dialogue'),
            character: z.string().nullable().optional(),
            text: z.string(),
          }),
        )
        .optional(),
    }),
  ),
  themes: z.array(z.string()),
  confidenceScore: z.number(),
  genres: z.array(z.string()),
  targetAudience: z.string(),
  tone: z.string(),
  style: z.string(),
  structure: z.string(),
  pacing: z.string(),
  dialogue: z.string(),
  action: z.string(),
  description: z.string(),
  environmentalInfluence: z.string(),
  conclusion: z.string(),
  relationship: z.string(),
  subText: z.string(),
  coreThought: z.string(),
});

// Export the interface for use in orchestrator
export type ScriptAnalysisResult = z.infer<typeof ScriptAnalysisSchema>;

const SceneSemanticSchema = z.object({
  number: z.number(),
  heading: z.string(),
  summary: z.string(),
  characters: z.array(z.string()),
  tone: z.string().optional().default(''),
  dramaticFunction: z.string().optional().default(''),
  conflict: z.string().optional().default(''),
  environmentalInfluence: z.string().optional().default(''),
  confidenceScore: z.number().optional().default(0.8),
});

const SceneCharacterInsightSchema = z.object({
  name: z.string(),
  description: z.string().optional().default(''),
  background: z.string().optional().default(''),
  definingPersonalityTraits: z.string().optional().default(''),
  perception: z.string().optional().default(''),
  goalAndConflict: z.string().optional().default(''),
  emotionalArc: z.string().optional().default(''),
  relationships: z.string().optional().default(''),
  subtextAndCoreTruth: z.string().optional().default(''),
});

const SceneSemanticBatchSchema = z.object({
  unitSummary: z.string().optional().default(''),
  themes: z.array(z.string()).optional().default([]),
  dialogueNote: z.string().optional().default(''),
  actionNote: z.string().optional().default(''),
  pacingNote: z.string().optional().default(''),
  warnings: z.array(z.string()).optional().default([]),
  confidenceScore: z.number().optional().default(0.8),
  scenes: z.array(SceneSemanticSchema),
  characterInsights: z
    .array(SceneCharacterInsightSchema)
    .optional()
    .default([]),
});

const ScriptSynthesisSchema = ScriptAnalysisSchema.omit({
  scenes: true,
});

type SceneSemanticBatchResult = z.infer<typeof SceneSemanticBatchSchema>;
type ScriptSynthesisResult = z.infer<typeof ScriptSynthesisSchema>;

type SemanticFailureClass =
  | 'timeout'
  | 'malformed_structured_output'
  | 'langchain_internal'
  | 'rate_limited'
  | 'other';

interface SemanticTelemetry {
  mode: 'chunked' | 'single_document' | 'scene_based';
  title: string;
  inputCharacters: number;
  totalUnits: number;
  successfulUnits: number;
  skippedUnits: number;
  timeoutUnits: number;
  malformedStructuredOutputUnits: number;
  langchainInternalUnits: number;
  rateLimitedUnits: number;
  otherFailedUnits: number;
}

interface SceneSemanticUnit {
  id: string;
  type: 'scene' | 'sequence';
  scenes: ScriptParserScene[];
  estimatedTextLength: number;
}

interface CharacterInsightAccumulator {
  description: Set<string>;
  background: Set<string>;
  definingPersonalityTraits: Set<string>;
  perception: Set<string>;
  goalAndConflict: Set<string>;
  emotionalArc: Set<string>;
  relationships: Set<string>;
  subtextAndCoreTruth: Set<string>;
}

interface SceneSemanticQualityGate {
  passed: boolean;
  reasons: string[];
  minimumSceneCoverageRatio: number;
  minimumSemanticUnitCoverageRatio: number;
  minimumGlobalFieldCount: number;
  overriddenByParserStructure?: boolean;
}

interface ParsedScriptSemanticMetadata {
  semanticStrategy: 'scene_based';
  totalScenes: number;
  coveredScenes: number;
  sceneCoverageRatio: number;
  totalSemanticUnits: number;
  successfulSemanticUnits: number;
  semanticUnitCoverageRatio: number;
  totalParserCharacters: number;
  synthesizedGlobalFieldCount: number;
  synthesisSucceeded: boolean;
  synthesisFallbackUsed: boolean;
  qualityGate: SceneSemanticQualityGate;
  sceneUnitBreakdown: Record<string, number>;
}

interface ParsedScriptSemanticAnalysis {
  analysisResult: ScriptAnalysisResult;
  semanticMetadata: ParsedScriptSemanticMetadata;
}

@Injectable()
export class GeminiService {
  private structuredLlm: any; // Runnable with structured output
  private logger = new Logger(GeminiService.name);
  private splitter: RecursiveCharacterTextSplitter;

  constructor(
    private readonly configService: ConfigService,
    private readonly geminiProvider: GeminiProvider,
    private readonly usageRecordRepository: UsageRecordRepository,
  ) {
    // Initialize text splitter for chunking
    // Use explicit configuration for consistent chunking across environments
    // Separators are ordered by priority - split on paragraphs first, then sentences, then words
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 3000,
      chunkOverlap: 200,
      separators: [
        '\n\n', // Paragraph breaks (highest priority)
        '\n', // Line breaks
        '. ', // Sentence endings
        '! ', // Exclamation endings
        '? ', // Question endings
        ' ', // Word boundaries
        '', // Character boundaries (fallback)
      ],
    });

    // Initialize Gemini LLM directly
    if (this.geminiProvider.isAvailable()) {
      this.structuredLlm = this.geminiProvider.getStructuredModel();
      this.logger.log('Gemini LLM initialized successfully');
    } else {
      this.logger.warn(
        'Gemini provider is not available. Check GOOGLE_GEMINI_API_KEY configuration.',
      );
    }
  }

  /**
   * Analyze script content using LangChain
   * @param scriptContent - The text content of the script
   * @param title - The title of the script
   * @param onProgress - Progress callback
   * @returns Structured analysis result
   */
  async analyzeScript(
    scriptContent: string,
    title: string,
    onProgress?: (progress: number, message: string, step?: string) => void,
    userId?: string,
  ): Promise<ScriptAnalysisResult> {
    if (!this.geminiProvider || !this.geminiProvider.isAvailable()) {
      throw new BadRequestException(
        'Gemini provider is not configured. Please check your GOOGLE_GEMINI_API_KEY configuration.',
      );
    }

    try {
      onProgress?.(10, 'Preparing script for analysis...', 'preparation');

      const perCallTimeoutMs = 180_000; // 180s timeout per model call (increased from 90s)

      // Log original content length and characteristics
      const lineCount = scriptContent.split('\n').length;
      const charCount = scriptContent.length;
      const wordCount = scriptContent.split(/\s+/).filter(Boolean).length;

      this.logger.log(
        `Original script content: ${charCount} characters, ${wordCount} words, ${lineCount} lines`,
      );

      // Normalize line endings to LF for consistent chunking across platforms
      const normalizedContent = scriptContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

      // Limit content to prevent token limits
      // Gemini 1.5 Pro can handle up to ~2M tokens, which is roughly 1.5M characters
      // We'll set a conservative limit of 500k characters to ensure we stay well within limits
      const maxContentLength = 500000; // 500k characters (~333k tokens, well within 2M limit)
      const truncatedContent =
        normalizedContent.length > maxContentLength
          ? normalizedContent.substring(0, maxContentLength) +
            '\n\n[Content truncated to 500k characters for processing...]'
          : normalizedContent;

      const truncatedLineCount = truncatedContent.split('\n').length;
      const truncatedWordCount = truncatedContent
        .split(/\s+/)
        .filter(Boolean).length;

      this.logger.log(
        `Content after normalization/truncation: ${truncatedContent.length} characters, ${truncatedWordCount} words, ${truncatedLineCount} lines`,
      );

      onProgress?.(20, 'Chunking script content...', 'chunking');

      // Log chunking configuration
      this.logger.debug(
        `Chunking config: chunkSize=${this.splitter.chunkSize}, chunkOverlap=${this.splitter.chunkOverlap}`,
      );

      // Split into chunks if content is large
      const chunks = await this.splitter.splitText(truncatedContent);
      const shouldChunk = chunks.length > 1;
      const semanticTelemetry: SemanticTelemetry = {
        mode: shouldChunk ? 'chunked' : 'single_document',
        title,
        inputCharacters: truncatedContent.length,
        totalUnits: shouldChunk ? chunks.length : 1,
        successfulUnits: 0,
        skippedUnits: 0,
        timeoutUnits: 0,
        malformedStructuredOutputUnits: 0,
        langchainInternalUnits: 0,
        rateLimitedUnits: 0,
        otherFailedUnits: 0,
      };

      // Log detailed chunking information
      const chunkSizes = chunks.map((chunk) => chunk.length);
      const avgChunkSize = Math.round(
        chunkSizes.reduce((a, b) => a + b, 0) / chunkSizes.length,
      );
      const minChunkSize = Math.min(...chunkSizes);
      const maxChunkSize = Math.max(...chunkSizes);

      this.logger.log(
        `Script split into ${chunks.length} chunks: avg=${avgChunkSize} chars, min=${minChunkSize}, max=${maxChunkSize} (original: ${charCount} chars, processed: ${truncatedContent.length} chars)`,
      );

      // Create prompt template
      const promptTemplate = PromptTemplate.fromTemplate(`
You are an expert script analyst. Perform a complete structured screenplay analysis.

Title: {title}

Script Content:
{script}

Extract the following information and return structured data:

1. **Summary**: A comprehensive 2-3 paragraph summary of the entire script
2. **Characters**: ALL characters that appear in the script (even minor ones)
   - Use each character's exact name as written in dialog or scene description
   - Provide a concise description (1-2 sentences) summarizing role, personality, or function
   - For each character, also extract:
     * **Background**: Character's background, history, and context within the story
     * **Defining Personality Traits**: Key personality traits that define the character
     * **Perception (Emotional/Mental)**: How the character perceives the world emotionally and mentally
     * **Goal & Conflict**: Character's primary goals and internal/external conflicts
     * **Emotional Arc**: Character's emotional journey throughout the script
     * **Relationships**: Character's relationships with other characters
     * **Subtext & Core Truth**: Underlying subtext and core truth about the character
     * **Voice Profile**: For text-to-speech voice casting — classify each character:
       - gender: "male", "female", or "neutral" (based on the character as written)
       - ageCategory: "young" (teens-20s), "middle" (30s-50s), or "old" (60s+)
       - accent: brief descriptor if apparent from dialogue (e.g., "British", "Southern American"), omit if not specified
3. **Scenes**: Every scene in the script
   - Include the scene heading exactly as written (INT./EXT./INT./EXT.)
   - Provide a clear summary of what happens (2-3 sentences)
   - List the page numbers where the scene appears (estimate if exact pages aren't clear, use increments of 1)
   - List ALL character names that appear in that scene
   - **Extract all scene elements in script order**: For each scene, include a "dialogues" array with ALL elements — dialogue, action lines, and parentheticals — in the exact order they appear in the script.
     * Each entry must have a "type" field: "dialogue" (spoken lines), "action" (stage directions/action lines), or "parenthetical" (actor directions like "(whispering)").
     * For dialogue entries: {{ "type": "dialogue", "character": "CHARACTER_NAME", "text": "the actual dialogue line" }}
     * For action lines: {{ "type": "action", "character": null, "text": "He slams his fist on the table." }}
     * For parentheticals: {{ "type": "parenthetical", "character": "CHARACTER_NAME", "text": "(whispering)" }}
     * **CRITICAL: Preserve the exact sequence as in the script.** Do NOT group by character or type. List each element in the order it appears (action, then Character A dialogue, then parenthetical, then Character B dialogue, etc.).
     * Include every dialogue line, action line, and parenthetical in order. If the same character speaks multiple times, use a separate entry for each line.
   - Scene numbering must be sequential starting from 1
4. **Themes**: Major themes and motifs present in the script
5. **Genres**: All applicable genres as simple labels only (e.g., "Drama", "Fantasy", "Comedy", "Thriller"). Do NOT add parenthetical qualifications or explanations — just the genre name itself. Deduplicate: each genre should appear at most once.
6. **Target Audience**: Primary target audience for this script
7. **Tone**: Overall tone of the script (e.g., Serious, Lighthearted, Dark, etc.)
8. **Style**: Writing style (e.g., Realistic, Stylized, Minimalist, etc.)
9. **Structure**: Narrative structure (e.g., Three-Act, Linear, Non-linear, etc.)
10. **Pacing**: Pacing of the script (e.g., Fast, Moderate, Slow, etc.)
11. **Dialogue**: Quality and style of dialogue (e.g., Natural, Stylized, Minimal, etc.)
12. **Action**: Amount and style of action (e.g., Action-heavy, Character-driven, Balanced, etc.)
13. **Description**: Overall description of the script's approach and execution
14. **Environmental Influence**: How the setting and environment influence the story, characters, and themes
15. **Conclusion**: Overall conclusion and key takeaways from the script analysis
16. **Relationship**: Analysis of relationships between characters and their dynamics
17. **SubText**: Underlying meanings, subtext, and implicit messages in the script
18. **Core Thought**: The central idea or core message that drives the script
19. **Confidence Score**: Confidence in the analysis (0.0 to 1.0)

IMPORTANT REQUIREMENTS:
- Extract ALL characters that appear in the script (even minor ones)
- Character names must match exactly as they appear in the script
- Ensure all character names in scenes exist in the characters array
- Scenes must be numbered sequentially starting from 1
- Return all fields, using empty strings or arrays if information is not available
- Return ONLY valid JSON that matches the required schema

CRITICAL JSON FORMATTING RULES:
- ALL string values MUST be properly escaped for JSON
- Escape all double quotes (") with backslash: \"
- Escape all backslashes (\) with double backslash: \\
- Escape all newlines (\n) with \\n
- Escape all carriage returns (\r) with \\r
- Escape all tabs (\t) with \\t
- Ensure all strings are properly closed with closing quotes
- Do NOT include unescaped quotes, newlines, or special characters in JSON strings
- If script content contains quotes or special characters, escape them properly
- Test that your JSON is valid before returning it
`);

      onProgress?.(30, 'Building analysis pipeline...', 'pipeline');

      onProgress?.(40, 'Running analysis...', 'analysis');

      let result: ScriptAnalysisResult;

      if (shouldChunk) {
        // Process chunks and merge results
        this.logger.debug(`Processing script in ${chunks.length} chunks`);
        const chunkResults: Partial<ScriptAnalysisResult>[] = [];
        const concurrencyLimit = 3; // Process 3 chunks in parallel

        // Process chunks in batches with concurrency limit
        for (let i = 0; i < chunks.length; i += concurrencyLimit) {
          const batch = chunks.slice(i, i + concurrencyLimit);
          const batchStartIndex = i;
          const batchEndIndex = Math.min(i + concurrencyLimit, chunks.length);

          // Emit progress once per batch (not per chunk) to avoid duplicate events
          onProgress?.(
            80 + Math.floor((batchEndIndex / chunks.length) * 15),
            `Processing chunks ${batchStartIndex + 1}-${batchEndIndex} of ${chunks.length}...`,
            'chunk_processing',
          );

          const batchPromises = batch.map(async (chunk, batchIndex) => {
            const chunkIndex = i + batchIndex + 1;
            const start = Date.now();

            const formattedPrompt = await promptTemplate.format({
              title,
              script: chunk,
            });

            this.logger.debug(
              `Invoking LLM for chunk ${chunkIndex}/${chunks.length} (len=${chunk.length})`,
            );

            try {
              // Log chunk info for debugging problematic chunks
              const chunkLength = chunk.length;
              const promptLength = formattedPrompt.length;
              this.logger.debug(
                `Processing chunk ${chunkIndex}/${chunks.length}: ${chunkLength} chars, prompt: ${promptLength} chars`,
              );

              // Warn if chunk is very large (might cause LangChain issues)
              if (chunkLength > 5000) {
                this.logger.warn(
                  `Chunk ${chunkIndex}/${chunks.length} is large (${chunkLength} chars). This may cause LangChain internal errors with certain content.`,
                );
              }

              const chunkResponse = await this.invokeWithTimeout(
                formattedPrompt,
                perCallTimeoutMs,
                `chunk_${chunkIndex}`,
                userId,
              );

              this.logger.debug(
                `Chunk ${chunkIndex}/${chunks.length} completed in ${Date.now() - start}ms`,
              );

              // Extract parsed result from structured output
              const chunkResult =
                (chunkResponse as any).parsed || chunkResponse;
              return chunkResult;
            } catch (chunkError: any) {
              const chunkErrorMessage =
                chunkError?.message ||
                chunkError?.toString() ||
                'Unknown error during chunk analysis';
              const failureClass = this.classifySemanticFailure(chunkError);
              this.incrementSemanticFailure(semanticTelemetry, failureClass);

              // Check if this is the LangChain undefined error
              const isLangChainUndefinedError =
                chunkErrorMessage.includes(
                  'Cannot read properties of undefined',
                ) || chunkError?.errorInfo?.isUndefinedPropertyError;

              // Log error with chunk details for debugging
              this.logger.error(
                `Chunk ${chunkIndex}/${chunks.length} failed after retries and will be skipped. ` +
                  `Chunk length: ${chunk.length} chars. ` +
                  `Error: ${chunkErrorMessage}` +
                  (isLangChainUndefinedError
                    ? ' (Known LangChain internal error - chunk will be skipped)'
                    : ''),
                chunkError?.stack || 'No stack trace available',
              );
              this.logger.warn(
                `[SemanticTelemetry] Chunk failure classified as ${failureClass} (chunk=${chunkIndex}/${chunks.length})`,
              );

              // Log a sample of the problematic chunk for debugging
              if (isLangChainUndefinedError && chunk.length > 0) {
                const chunkSample = chunk.substring(0, 200);
                this.logger.debug(
                  `Problematic chunk ${chunkIndex} sample (first 200 chars): ${chunkSample}...`,
                );
              }

              // Return null to indicate failure
              return null;
            }
          });

          // Wait for batch to complete
          const batchResults = await Promise.all(batchPromises);

          // Add successful results to chunkResults
          for (const result of batchResults) {
            if (result !== null) {
              chunkResults.push(result);
            }
          }
        }

        const totalChunks = chunks.length;
        const successfulChunks = chunkResults.length;
        const failedChunks = totalChunks - successfulChunks;
        const failureRate = (failedChunks / totalChunks) * 100;
        const successRate = (successfulChunks / totalChunks) * 100;
        semanticTelemetry.successfulUnits = successfulChunks;

        this.logger.log(
          `Chunk processing complete: ${successfulChunks}/${totalChunks} successful, ${failedChunks} failed (${successRate.toFixed(1)}% success rate, ${failureRate.toFixed(1)}% failure rate)`,
        );

        // Fail if failure rate is 40% or higher
        if (failureRate >= 40) {
          this.logSemanticTelemetry('failed', semanticTelemetry, {
            successRate,
            failureRate,
            failureClass: 'excessive_skipped_units',
          });
          this.logger.error(
            `Analysis failed: ${failureRate.toFixed(1)}% of chunks failed (${failedChunks}/${totalChunks}), which exceeds the 40% failure threshold. The script may be too large, corrupted, or the model is experiencing issues.`,
          );
          throw new Error(
            `Analysis failed: ${failedChunks} out of ${totalChunks} chunks failed (${failureRate.toFixed(1)}% failure rate). ` +
              `This exceeds the 40% failure threshold. The script may be too large, contain problematic content, or the model is experiencing issues. ` +
              `Please try again later or check the script content.`,
          );
        }

        if (chunkResults.length === 0) {
          // If every chunk failed we cannot recover – surface a clear error
          this.logSemanticTelemetry('failed', semanticTelemetry, {
            successRate,
            failureRate,
            failureClass: 'all_units_failed',
          });
          throw new Error(
            `All ${chunks.length} analysis chunks failed after retries. The script may be too large or the model is experiencing issues. Please try again later.`,
          );
        }

        this.logSemanticTelemetry('success', semanticTelemetry, {
          successRate,
          failureRate,
        });
        this.logger.log(
          `Successfully processed ${chunkResults.length}/${chunks.length} chunks (${successRate.toFixed(1)}% success rate). Analysis will continue with successful chunks.`,
        );

        onProgress?.(95, 'Merging chunk results...', 'merge');

        // Merge successful chunk results
        result = this.mergeChunkResults(chunkResults, title);
      } else {
        // Process as single document
        const formattedPrompt = await promptTemplate.format({
          title,
          script: truncatedContent,
        });

        this.logger.debug(
          `Invoking LLM for full script (len=${truncatedContent.length})`,
        );
        try {
          const start = Date.now();
          const response = await this.invokeWithTimeout(
            formattedPrompt,
            perCallTimeoutMs,
            'full_document',
            userId,
          );
          this.logger.debug(
            `Full script analysis completed in ${Date.now() - start}ms`,
          );
          semanticTelemetry.successfulUnits = 1;
          this.logSemanticTelemetry('success', semanticTelemetry);
          // Extract parsed result from structured output
          result = (response as any).parsed || response;
        } catch (fullDocumentError: any) {
          const failureClass = this.classifySemanticFailure(fullDocumentError);
          this.incrementSemanticFailure(semanticTelemetry, failureClass);
          this.logSemanticTelemetry('failed', semanticTelemetry, {
            failureClass,
          });
          throw fullDocumentError;
        }
      }

      onProgress?.(100, 'Analysis complete!', 'completed');

      // Validate and normalize the response
      return this.validateAndNormalizeAnalysis(result, title);
    } catch (error: any) {
      const errorMessage =
        error?.message ||
        error?.toString() ||
        'Unknown error during AI analysis';
      const errorStack = error?.stack || 'No stack trace available';

      this.logger.error(
        `Error analyzing script with LangChain: ${errorMessage}`,
        errorStack,
      );
      throw new BadRequestException(`AI analysis failed: ${errorMessage}`);
    }
  }

  async analyzeParsedScript(
    parseResult: ScriptParserResultPayload,
    title: string,
    onProgress?: (progress: number, message: string, step?: string) => void,
    userId?: string,
  ): Promise<ParsedScriptSemanticAnalysis> {
    if (!this.geminiProvider || !this.geminiProvider.isAvailable()) {
      throw new BadRequestException(
        'Gemini provider is not configured. Please check your GOOGLE_GEMINI_API_KEY configuration.',
      );
    }

    const scenes = [...(parseResult.scenes || [])]
      .filter((scene) => scene && scene.number != null)
      .sort((a, b) => a.number - b.number);

    if (!scenes.length) {
      this.logger.warn(
        '[SceneSemantic] Parser returned no scenes. Falling back to legacy raw-text analysis.',
      );
      const fallbackAnalysis = await this.analyzeScript(
        parseResult.clean_text,
        title,
        onProgress,
        userId,
      );
      return {
        analysisResult: fallbackAnalysis,
        semanticMetadata: {
          semanticStrategy: 'scene_based',
          totalScenes: 0,
          coveredScenes: 0,
          sceneCoverageRatio: 0,
          totalSemanticUnits: 0,
          successfulSemanticUnits: 0,
          semanticUnitCoverageRatio: 0,
          totalParserCharacters: parseResult.characters.length,
          synthesizedGlobalFieldCount: 0,
          synthesisSucceeded: false,
          synthesisFallbackUsed: true,
          qualityGate: {
            passed: false,
            reasons: ['Parser returned no scenes for scene-based analysis.'],
            minimumSceneCoverageRatio: 1,
            minimumSemanticUnitCoverageRatio: 1,
            minimumGlobalFieldCount: 6,
          },
          sceneUnitBreakdown: {},
        },
      };
    }

    const semanticUnits = this.buildSceneSemanticUnits(
      scenes,
      parseResult.low_confidence_flag,
    );

    const semanticTelemetry: SemanticTelemetry = {
      mode: 'scene_based',
      title,
      inputCharacters: parseResult.clean_text.length,
      totalUnits: semanticUnits.length,
      successfulUnits: 0,
      skippedUnits: 0,
      timeoutUnits: 0,
      malformedStructuredOutputUnits: 0,
      langchainInternalUnits: 0,
      rateLimitedUnits: 0,
      otherFailedUnits: 0,
    };

    this.logger.log(
      `[SceneSemantic] Built ${semanticUnits.length} semantic unit(s) from ${scenes.length} scene(s) for "${title}"`,
    );
    this.logger.log(
      `[SceneSemantic] Unit breakdown ${JSON.stringify({
        title,
        unitTypeBreakdown: this.buildSceneUnitBreakdown(semanticUnits),
        parserWarnings: parseResult.parser_warnings || [],
        lowConfidenceFlag: parseResult.low_confidence_flag,
        watermarkDetected: parseResult.watermark_detected,
      })}`,
    );

    onProgress?.(38, 'Preparing scene-based semantic analysis...', 'analysis');

    const sceneBatchModel = this.geminiProvider.createStructuredModel(
      SceneSemanticBatchSchema,
    );
    const unitResults: SceneSemanticBatchResult[] = [];
    const concurrencyLimit = 2;
    const perCallTimeoutMs = 120_000;

    for (let i = 0; i < semanticUnits.length; i += concurrencyLimit) {
      const batch = semanticUnits.slice(i, i + concurrencyLimit);
      const batchEnd = Math.min(i + concurrencyLimit, semanticUnits.length);

      onProgress?.(
        42 + Math.floor((batchEnd / semanticUnits.length) * 24),
        `Analyzing scene units ${i + 1}-${batchEnd} of ${semanticUnits.length}...`,
        'scene_analysis',
      );

      const batchResults = await Promise.all(
        batch.map(async (unit) => {
          const context = `${unit.type}_${unit.scenes[0]?.number}_${unit.scenes[unit.scenes.length - 1]?.number}`;
          const prompt = this.buildSceneSemanticPrompt(
            title,
            parseResult,
            unit,
          );

          try {
            const response = await this.invokeWithTimeout(
              prompt,
              perCallTimeoutMs,
              context,
              userId,
              3,
              sceneBatchModel,
            );
            return (response as any).parsed || response;
          } catch (error: any) {
            const failureClass = this.classifySemanticFailure(error);
            this.incrementSemanticFailure(semanticTelemetry, failureClass);
            this.logger.error(
              `[SceneSemantic] ${unit.id} failed after retries and will be skipped: ${error?.message || error}`,
              error?.stack || 'No stack trace available',
            );
            return null;
          }
        }),
      );

      for (const batchResult of batchResults) {
        if (batchResult) {
          unitResults.push(batchResult);
        }
      }

      this.logger.log(
        `[SceneSemantic] Batch progress ${JSON.stringify({
          title,
          completedUnits: batchEnd,
          totalUnits: semanticUnits.length,
          successfulUnits: unitResults.length,
          failedUnits: semanticTelemetry.totalUnits - unitResults.length,
          batchUnitIds: batch.map((unit) => unit.id),
        })}`,
      );
    }

    semanticTelemetry.successfulUnits = unitResults.length;
    const failedUnits = semanticTelemetry.totalUnits - unitResults.length;
    const failureRate =
      semanticTelemetry.totalUnits > 0
        ? (failedUnits / semanticTelemetry.totalUnits) * 100
        : 100;

    if (!unitResults.length) {
      this.logSemanticTelemetry('failed', semanticTelemetry, {
        failureRate,
        failureClass: 'all_scene_units_failed',
      });
      this.logger.warn(
        '[SceneSemantic] All scene-based calls failed. Falling back to legacy raw-text analysis.',
      );
      const fallbackAnalysis = await this.analyzeScript(
        parseResult.clean_text,
        title,
        onProgress,
        userId,
      );
      return {
        analysisResult: fallbackAnalysis,
        semanticMetadata: {
          semanticStrategy: 'scene_based',
          totalScenes: scenes.length,
          coveredScenes: 0,
          sceneCoverageRatio: 0,
          totalSemanticUnits: semanticUnits.length,
          successfulSemanticUnits: 0,
          semanticUnitCoverageRatio: 0,
          totalParserCharacters: parseResult.characters.length,
          synthesizedGlobalFieldCount: 0,
          synthesisSucceeded: false,
          synthesisFallbackUsed: true,
          qualityGate: {
            passed: false,
            reasons: ['All scene semantic units failed after retries.'],
            minimumSceneCoverageRatio: this.getMinimumSceneCoverageRatio(
              scenes.length,
            ),
            minimumSemanticUnitCoverageRatio:
              this.getMinimumSemanticUnitCoverageRatio(semanticUnits.length),
            minimumGlobalFieldCount: this.getMinimumGlobalFieldCount(
              scenes.length,
            ),
          },
          sceneUnitBreakdown: this.buildSceneUnitBreakdown(semanticUnits),
        },
      };
    }

    this.logSemanticTelemetry('success', semanticTelemetry, {
      failureRate,
      unitTypeBreakdown: semanticUnits.reduce<Record<string, number>>(
        (acc, unit) => {
          acc[unit.type] = (acc[unit.type] || 0) + 1;
          return acc;
        },
        {},
      ),
    });

    onProgress?.(
      70,
      'Synthesizing whole-script analysis from scene outputs...',
      'synthesis',
    );

    const sceneCards = this.buildSceneCardsFromSemanticResults(
      parseResult,
      unitResults,
    );
    const characterInsights = this.aggregateCharacterInsights(unitResults);
    this.logger.log(
      `[SceneSemantic] Starting synthesis ${JSON.stringify({
        title,
        sceneCardCount: sceneCards.length,
        characterInsightCount: characterInsights.size,
      })}`,
    );

    let synthesisResult: Partial<ScriptSynthesisResult> | null = null;
    try {
      const synthesisModel = this.geminiProvider.createStructuredModel(
        ScriptSynthesisSchema,
      );
      const synthesisPrompt = this.buildScriptSynthesisPrompt(
        title,
        parseResult,
        sceneCards,
        characterInsights,
      );
      const synthesisResponse = await this.invokeWithTimeout(
        synthesisPrompt,
        120_000,
        'scene_synthesis',
        userId,
        2,
        synthesisModel,
      );
      synthesisResult =
        ((synthesisResponse as any).parsed || synthesisResponse) ?? null;
    } catch (error: any) {
      this.logger.warn(
        `[SceneSemantic] Whole-script synthesis failed. Falling back to heuristic aggregation: ${error?.message || error}`,
      );
    }
    this.logger.log(
      `[SceneSemantic] Synthesis result ${JSON.stringify({
        title,
        synthesisSucceeded: Boolean(synthesisResult),
        synthesisFallbackUsed: !Boolean(synthesisResult),
      })}`,
    );

    onProgress?.(78, 'Assembling scene-based analysis result...', 'assembly');

    const analysisResult = this.assembleSceneBasedAnalysisResult(
      title,
      parseResult,
      sceneCards,
      characterInsights,
      synthesisResult,
    );
    const semanticMetadata = this.buildSemanticMetadata(
      parseResult,
      semanticUnits,
      unitResults,
      sceneCards,
      synthesisResult,
      Boolean(synthesisResult),
      analysisResult,
    );
    this.logger.log(
      `[SceneSemantic] Quality gate evaluated ${JSON.stringify({
        title,
        totalScenes: semanticMetadata.totalScenes,
        coveredScenes: semanticMetadata.coveredScenes,
        sceneCoverageRatio: semanticMetadata.sceneCoverageRatio,
        totalSemanticUnits: semanticMetadata.totalSemanticUnits,
        successfulSemanticUnits: semanticMetadata.successfulSemanticUnits,
        semanticUnitCoverageRatio: semanticMetadata.semanticUnitCoverageRatio,
        synthesizedGlobalFieldCount:
          semanticMetadata.synthesizedGlobalFieldCount,
        synthesisSucceeded: semanticMetadata.synthesisSucceeded,
        synthesisFallbackUsed: semanticMetadata.synthesisFallbackUsed,
        qualityGate: semanticMetadata.qualityGate,
      })}`,
    );

    if (!semanticMetadata.qualityGate.passed) {
      // Check if parser found good structural data (real scenes with dialogue).
      // If so, keep the scene-semantic result — partial Gemini summaries are
      // better than losing all parser scenes to legacy chunking.
      const parserHasGoodStructure =
        parseResult.scenes?.length >= 3 &&
        parseResult.scenes.some((s) =>
          s.elements.some(
            (el) => el.type === 'dialogue' || el.type === 'character',
          ),
        );

      if (parserHasGoodStructure) {
        this.logger.log(
          `[SceneSemantic] Quality gate failed but parser has good structure ` +
            `(${parseResult.scenes.length} scenes). Keeping scene-semantic result ` +
            `instead of falling back to legacy chunking.`,
        );
        return {
          analysisResult,
          semanticMetadata: {
            ...semanticMetadata,
            qualityGate: {
              ...semanticMetadata.qualityGate,
              overriddenByParserStructure: true,
            },
          },
        };
      }

      this.logger.warn(
        `[SceneSemantic] Quality gate failed for "${title}". Falling back to legacy raw-text analysis. Reasons: ${semanticMetadata.qualityGate.reasons.join(' | ')}`,
      );
      const fallbackAnalysis = await this.analyzeScript(
        parseResult.clean_text,
        title,
        onProgress,
        userId,
      );
      return {
        analysisResult: fallbackAnalysis,
        semanticMetadata: {
          ...semanticMetadata,
          synthesisFallbackUsed: true,
        },
      };
    }

    return {
      analysisResult,
      semanticMetadata,
    };
  }

  public buildSceneSemanticUnits(
    scenes: ScriptParserScene[],
    lowConfidenceFlag: boolean,
  ): SceneSemanticUnit[] {
    const minUnitChars = lowConfidenceFlag ? 1200 : 900;
    const targetUnitChars = lowConfidenceFlag ? 2400 : 1800;
    const maxUnitChars = 4200;
    const maxScenesPerUnit = lowConfidenceFlag ? 4 : 3;
    const units: SceneSemanticUnit[] = [];

    for (let index = 0; index < scenes.length; ) {
      const initialScene = scenes[index];
      const unitScenes = [initialScene];
      let totalChars = this.estimateSceneTextLength(initialScene);
      const shouldGroup =
        lowConfidenceFlag || this.isSceneSemanticallyThin(initialScene);

      while (
        index + unitScenes.length < scenes.length &&
        unitScenes.length < maxScenesPerUnit &&
        totalChars < targetUnitChars &&
        (shouldGroup || totalChars < minUnitChars)
      ) {
        const nextScene = scenes[index + unitScenes.length];
        const nextSceneChars = this.estimateSceneTextLength(nextScene);
        if (totalChars + nextSceneChars > maxUnitChars) {
          break;
        }
        unitScenes.push(nextScene);
        totalChars += nextSceneChars;
      }

      units.push({
        id:
          unitScenes.length === 1
            ? `scene-${unitScenes[0].number}`
            : `sequence-${unitScenes[0].number}-${unitScenes[unitScenes.length - 1].number}`,
        type: unitScenes.length === 1 ? 'scene' : 'sequence',
        scenes: unitScenes,
        estimatedTextLength: totalChars,
      });

      index += unitScenes.length;
    }

    return units;
  }

  /**
   * Build consolidation units for narrative-coherent scene grouping.
   * Groups consecutive scenes at the same location, merges very short scenes
   * with neighbors, and targets 10-25 consolidated scenes for a typical screenplay.
   */
  public buildConsolidationUnits(
    scenes: ScriptParserScene[],
  ): SceneSemanticUnit[] {
    if (scenes.length === 0) return [];

    const MAX_SCENES_PER_UNIT = 30;
    const MAX_CHARS_PER_UNIT = 8000;
    const SHORT_SCENE_THRESHOLD = 3; // elements

    // Extract location from heading: "INT. KITCHEN - DAY" → "KITCHEN"
    const extractLocation = (heading: string): string => {
      const cleaned = heading
        .replace(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|INT\.?|EXT\.?|I\/E)\s*/i, '')
        .replace(
          /\s*[-–—]\s*(DAY|NIGHT|MORNING|EVENING|DAWN|DUSK|LATER|CONTINUOUS|SAME|MOMENTS LATER|SAME TIME)\s*$/i,
          '',
        )
        .trim();
      return cleaned.toUpperCase() || 'UNKNOWN';
    };

    // First pass: group by consecutive location
    const rawUnits: ScriptParserScene[][] = [];
    let currentGroup: ScriptParserScene[] = [scenes[0]];
    let currentLocation = extractLocation(scenes[0].heading);

    for (let i = 1; i < scenes.length; i++) {
      const scene = scenes[i];
      const location = extractLocation(scene.heading);
      const groupChars = currentGroup.reduce(
        (sum, s) => sum + this.estimateSceneTextLength(s),
        0,
      );
      const sceneChars = this.estimateSceneTextLength(scene);

      // Merge if same location and within size limits
      if (
        location === currentLocation &&
        currentGroup.length < MAX_SCENES_PER_UNIT &&
        groupChars + sceneChars <= MAX_CHARS_PER_UNIT
      ) {
        currentGroup.push(scene);
      } else {
        rawUnits.push(currentGroup);
        currentGroup = [scene];
        currentLocation = location;
      }
    }
    rawUnits.push(currentGroup);

    // Second pass: merge very short scenes (< 3 elements) with previous unit
    const mergedUnits: ScriptParserScene[][] = [];
    for (const unit of rawUnits) {
      const totalElements = unit.reduce((sum, s) => sum + s.elements.length, 0);
      if (totalElements < SHORT_SCENE_THRESHOLD && mergedUnits.length > 0) {
        const prev = mergedUnits[mergedUnits.length - 1];
        const prevChars = prev.reduce(
          (sum, s) => sum + this.estimateSceneTextLength(s),
          0,
        );
        const unitChars = unit.reduce(
          (sum, s) => sum + this.estimateSceneTextLength(s),
          0,
        );
        if (
          prev.length + unit.length <= MAX_SCENES_PER_UNIT &&
          prevChars + unitChars <= MAX_CHARS_PER_UNIT
        ) {
          prev.push(...unit);
          continue;
        }
      }
      mergedUnits.push(unit);
    }

    // Third pass: if too many units, merge smallest adjacent pairs
    let finalUnits = mergedUnits;
    while (finalUnits.length > 30) {
      let minSize = Number.POSITIVE_INFINITY;
      let minIdx = 0;
      for (let i = 0; i < finalUnits.length - 1; i++) {
        const combinedSize =
          finalUnits[i].reduce(
            (sum, s) => sum + this.estimateSceneTextLength(s),
            0,
          ) +
          finalUnits[i + 1].reduce(
            (sum, s) => sum + this.estimateSceneTextLength(s),
            0,
          );
        if (combinedSize < minSize) {
          minSize = combinedSize;
          minIdx = i;
        }
      }
      const merged = [...finalUnits[minIdx], ...finalUnits[minIdx + 1]];
      finalUnits = [
        ...finalUnits.slice(0, minIdx),
        merged,
        ...finalUnits.slice(minIdx + 2),
      ];
    }

    // Convert to SceneSemanticUnit format
    return finalUnits.map((groupScenes, idx) => ({
      id:
        groupScenes.length === 1
          ? `consolidated-scene-${groupScenes[0].number}`
          : `consolidated-${groupScenes[0].number}-${groupScenes[groupScenes.length - 1].number}`,
      type: (groupScenes.length === 1 ? 'scene' : 'sequence') as
        | 'scene'
        | 'sequence',
      scenes: groupScenes,
      estimatedTextLength: groupScenes.reduce(
        (sum, s) => sum + this.estimateSceneTextLength(s),
        0,
      ),
    }));
  }

  private isSceneSemanticallyThin(scene: ScriptParserScene): boolean {
    const textLength = this.estimateSceneTextLength(scene);
    const dialogueElements = scene.elements.filter(
      (element) => element.type === 'dialogue',
    ).length;
    return (
      textLength < 650 ||
      scene.elements.length < 5 ||
      dialogueElements === 0 ||
      !scene.heading?.trim()
    );
  }

  private estimateSceneTextLength(scene: ScriptParserScene): number {
    return scene.elements.reduce(
      (total, element) => total + (element.text?.length || 0),
      scene.heading?.length || 0,
    );
  }

  private buildSceneSemanticPrompt(
    title: string,
    parseResult: ScriptParserResultPayload,
    unit: SceneSemanticUnit,
  ): string {
    const knownCharacters = parseResult.characters
      .map((character) => `${character.name} (${character.line_count} lines)`)
      .join(', ');

    return [
      'You are analyzing screenplay scenes for semantic meaning.',
      'Analyze only the scenes provided below. Do not invent events outside this unit.',
      '',
      `Title: ${title}`,
      `Unit Type: ${unit.type}`,
      `Known Character Roster: ${knownCharacters || 'Unknown'}`,
      `Parser Warnings: ${parseResult.parser_warnings.join(' | ') || 'None'}`,
      `Watermark Detected: ${parseResult.watermark_detected ? 'yes' : 'no'}`,
      '',
      'Return one semantic entry for every scene in the input.',
      'For each scene:',
      '- keep the original scene number and heading',
      '- summarize what happens in 2-4 sentences',
      '- list only characters actually present in that scene',
      '- describe the local tone, dramatic function, and active conflict',
      '- mention environmental influence only if it materially affects the scene',
      '',
      'Also return scene-local character insights only for characters visible in this unit.',
      'Do not write whole-script conclusions in this pass.',
      '',
      'Scene Unit:',
      this.renderSemanticUnit(unit),
    ].join('\n');
  }

  private renderSemanticUnit(unit: SceneSemanticUnit): string {
    return unit.scenes
      .map((scene) => {
        const pages =
          scene.page_start &&
          scene.page_end &&
          scene.page_end >= scene.page_start
            ? `${scene.page_start}-${scene.page_end}`
            : scene.page_start?.toString() || 'unknown';

        return [
          `[SCENE ${scene.number}] ${scene.heading}`,
          `Pages: ${pages}`,
          scene.elements
            .map((element) => this.renderSceneElement(element))
            .join('\n'),
        ].join('\n');
      })
      .join('\n\n');
  }

  private renderSceneElement(element: ScriptParserElement): string {
    if (element.type === 'dialogue') {
      return `DIALOGUE ${element.character_name || 'UNKNOWN'}: ${element.text}`;
    }
    if (element.type === 'parenthetical') {
      return `PARENTHETICAL ${element.character_name || 'UNKNOWN'}: ${element.text}`;
    }
    if (element.type === 'character') {
      return `CHARACTER CUE: ${element.character_name || element.text}`;
    }
    if (element.type === 'transition') {
      return `TRANSITION: ${element.text}`;
    }
    return `ACTION: ${element.text}`;
  }

  private buildSceneCardsFromSemanticResults(
    parseResult: ScriptParserResultPayload,
    unitResults: SceneSemanticBatchResult[],
  ): ScriptAnalysisResult['scenes'] {
    const semanticSceneMap = new Map<
      number,
      SceneSemanticBatchResult['scenes'][0]
    >();
    for (const unitResult of unitResults) {
      for (const scene of unitResult.scenes || []) {
        semanticSceneMap.set(scene.number, scene);
      }
    }

    return [...(parseResult.scenes || [])]
      .sort((a, b) => a.number - b.number)
      .map((parserScene) => {
        const semanticScene = semanticSceneMap.get(parserScene.number);
        return {
          number: parserScene.number,
          heading: parserScene.heading || semanticScene?.heading || '',
          summary:
            semanticScene?.summary?.trim() ||
            this.buildFallbackSceneSummary(parserScene),
          pages: this.extractScenePages(parserScene),
          characters: semanticScene?.characters?.length
            ? [...new Set(semanticScene.characters.map((name) => name.trim()))]
            : this.extractParserSceneCharacters(parserScene),
          dialogues: this.extractParserSceneDialogues(parserScene),
        };
      });
  }

  private aggregateCharacterInsights(
    unitResults: SceneSemanticBatchResult[],
  ): Map<string, CharacterInsightAccumulator> {
    const characterInsights = new Map<string, CharacterInsightAccumulator>();

    for (const unitResult of unitResults) {
      for (const insight of unitResult.characterInsights || []) {
        const key = insight.name.trim().toUpperCase();
        if (!key) continue;

        const accumulator =
          characterInsights.get(key) ||
          this.createCharacterInsightAccumulator();

        this.addInsightText(accumulator.description, insight.description);
        this.addInsightText(accumulator.background, insight.background);
        this.addInsightText(
          accumulator.definingPersonalityTraits,
          insight.definingPersonalityTraits,
        );
        this.addInsightText(accumulator.perception, insight.perception);
        this.addInsightText(
          accumulator.goalAndConflict,
          insight.goalAndConflict,
        );
        this.addInsightText(accumulator.emotionalArc, insight.emotionalArc);
        this.addInsightText(accumulator.relationships, insight.relationships);
        this.addInsightText(
          accumulator.subtextAndCoreTruth,
          insight.subtextAndCoreTruth,
        );

        characterInsights.set(key, accumulator);
      }
    }

    return characterInsights;
  }

  private createCharacterInsightAccumulator(): CharacterInsightAccumulator {
    return {
      description: new Set<string>(),
      background: new Set<string>(),
      definingPersonalityTraits: new Set<string>(),
      perception: new Set<string>(),
      goalAndConflict: new Set<string>(),
      emotionalArc: new Set<string>(),
      relationships: new Set<string>(),
      subtextAndCoreTruth: new Set<string>(),
    };
  }

  private addInsightText(target: Set<string>, value?: string | null) {
    if (!value?.trim()) return;
    target.add(value.trim());
  }

  private buildScriptSynthesisPrompt(
    title: string,
    parseResult: ScriptParserResultPayload,
    sceneCards: ScriptAnalysisResult['scenes'],
    characterInsights: Map<string, CharacterInsightAccumulator>,
  ): string {
    const sceneSummaries = sceneCards
      .map((scene) =>
        [
          `Scene ${scene.number}: ${scene.heading}`,
          `Summary: ${scene.summary.substring(0, 500)}`,
          `Characters: ${scene.characters.join(', ') || 'Unknown'}`,
          `Pages: ${scene.pages.join(', ') || 'Unknown'}`,
        ].join('\n'),
      )
      .join('\n\n');

    const characterNotes = this.collectKnownCharacterNames(
      parseResult,
      sceneCards,
    )
      .map((name) => {
        const insight = characterInsights.get(name.toUpperCase());
        return [
          `Character: ${name}`,
          `Observed description: ${this.joinInsightValues(insight?.description) || 'Unknown'}`,
          `Observed traits: ${this.joinInsightValues(insight?.definingPersonalityTraits) || 'Unknown'}`,
          `Observed goals/conflicts: ${this.joinInsightValues(insight?.goalAndConflict) || 'Unknown'}`,
          `Observed relationships: ${this.joinInsightValues(insight?.relationships) || 'Unknown'}`,
        ].join('\n');
      })
      .join('\n\n');

    return [
      'You are synthesizing a whole-script analysis from structured scene cards.',
      'Do not invent scenes, characters, or beats that are not supported by the scene cards.',
      '',
      `Title: ${title}`,
      `Parser Format: ${parseResult.format}`,
      `Scene Count: ${sceneCards.length}`,
      `Page Count: ${parseResult.page_count}`,
      `Structure Confidence: ${parseResult.structure_confidence_score}`,
      `Parser Warnings: ${parseResult.parser_warnings.join(' | ') || 'None'}`,
      '',
      'Use the scene cards and character observations to produce:',
      '- whole-script summary',
      '- character-level descriptions and arcs',
      '- themes, genres, audience, tone, style, structure, pacing',
      '- dialogue/action/environment/relationship/subtext/core thought fields',
      '',
      'Scene Cards:',
      sceneSummaries,
      '',
      'Character Observations:',
      characterNotes || 'No character observations available',
    ].join('\n');
  }

  private assembleSceneBasedAnalysisResult(
    title: string,
    parseResult: ScriptParserResultPayload,
    sceneCards: ScriptAnalysisResult['scenes'],
    characterInsights: Map<string, CharacterInsightAccumulator>,
    synthesisResult: Partial<ScriptSynthesisResult> | null,
  ): ScriptAnalysisResult {
    const characterLookup = new Map<
      string,
      ScriptAnalysisResult['characters'][0]
    >();

    for (const character of synthesisResult?.characters || []) {
      const key = character.name.trim().toUpperCase();
      if (!key) continue;
      characterLookup.set(key, {
        name: character.name.trim(),
        description: character.description?.trim() || '',
        background: character.background?.trim() || '',
        definingPersonalityTraits:
          character.definingPersonalityTraits?.trim() || '',
        perception: character.perception?.trim() || '',
        goalAndConflict: character.goalAndConflict?.trim() || '',
        emotionalArc: character.emotionalArc?.trim() || '',
        relationships: character.relationships?.trim() || '',
        subtextAndCoreTruth: character.subtextAndCoreTruth?.trim() || '',
      });
    }

    for (const name of this.collectKnownCharacterNames(
      parseResult,
      sceneCards,
    )) {
      const key = name.toUpperCase();
      const existing = characterLookup.get(key);
      const insights = characterInsights.get(key);
      characterLookup.set(key, {
        name,
        description:
          existing?.description ||
          this.joinInsightValues(insights?.description) ||
          '',
        background:
          existing?.background ||
          this.joinInsightValues(insights?.background) ||
          '',
        definingPersonalityTraits:
          existing?.definingPersonalityTraits ||
          this.joinInsightValues(insights?.definingPersonalityTraits) ||
          '',
        perception:
          existing?.perception ||
          this.joinInsightValues(insights?.perception) ||
          '',
        goalAndConflict:
          existing?.goalAndConflict ||
          this.joinInsightValues(insights?.goalAndConflict) ||
          '',
        emotionalArc:
          existing?.emotionalArc ||
          this.joinInsightValues(insights?.emotionalArc) ||
          '',
        relationships:
          existing?.relationships ||
          this.joinInsightValues(insights?.relationships) ||
          '',
        subtextAndCoreTruth:
          existing?.subtextAndCoreTruth ||
          this.joinInsightValues(insights?.subtextAndCoreTruth) ||
          '',
      });
    }

    const heuristicSummary = sceneCards.length
      ? sceneCards
          .slice(0, 3)
          .map((scene) => scene.summary)
          .filter(Boolean)
          .join(' ')
      : `Scene-based analysis completed for ${title}.`;

    return this.validateAndNormalizeAnalysis(
      {
        summary: synthesisResult?.summary || heuristicSummary,
        characters: Array.from(characterLookup.values()),
        scenes: sceneCards,
        themes: synthesisResult?.themes || [],
        confidenceScore: synthesisResult?.confidenceScore || 0.85,
        genres: synthesisResult?.genres || [],
        targetAudience: synthesisResult?.targetAudience || '',
        tone: synthesisResult?.tone || '',
        style: synthesisResult?.style || '',
        structure: synthesisResult?.structure || '',
        pacing: synthesisResult?.pacing || '',
        dialogue: synthesisResult?.dialogue || '',
        action: synthesisResult?.action || '',
        description: synthesisResult?.description || '',
        environmentalInfluence: synthesisResult?.environmentalInfluence || '',
        conclusion: synthesisResult?.conclusion || '',
        relationship: synthesisResult?.relationship || '',
        subText: synthesisResult?.subText || '',
        coreThought: synthesisResult?.coreThought || '',
      },
      title,
    );
  }

  private buildSemanticMetadata(
    parseResult: ScriptParserResultPayload,
    semanticUnits: SceneSemanticUnit[],
    unitResults: SceneSemanticBatchResult[],
    sceneCards: ScriptAnalysisResult['scenes'],
    synthesisResult: Partial<ScriptSynthesisResult> | null,
    synthesisSucceeded: boolean,
    analysisResult: ScriptAnalysisResult,
  ): ParsedScriptSemanticMetadata {
    const totalScenes = parseResult.scenes.length;
    const coveredSceneNumbers = new Set(
      unitResults.flatMap((unitResult) =>
        (unitResult.scenes || []).map((scene) => scene.number),
      ),
    );
    const coveredScenes = coveredSceneNumbers.size;
    const sceneCoverageRatio =
      totalScenes > 0 ? coveredScenes / totalScenes : 0;
    const totalSemanticUnits = semanticUnits.length;
    const successfulSemanticUnits = unitResults.length;
    const semanticUnitCoverageRatio =
      totalSemanticUnits > 0 ? successfulSemanticUnits / totalSemanticUnits : 0;
    const synthesizedGlobalFieldCount = this.countSynthesizedGlobalFields(
      synthesisResult,
      analysisResult,
    );
    const qualityGate = this.evaluateSemanticQualityGate(
      totalScenes,
      totalSemanticUnits,
      sceneCoverageRatio,
      semanticUnitCoverageRatio,
      synthesizedGlobalFieldCount,
      synthesisSucceeded,
    );

    return {
      semanticStrategy: 'scene_based',
      totalScenes,
      coveredScenes,
      sceneCoverageRatio,
      totalSemanticUnits,
      successfulSemanticUnits,
      semanticUnitCoverageRatio,
      totalParserCharacters: parseResult.characters.length,
      synthesizedGlobalFieldCount,
      synthesisSucceeded,
      synthesisFallbackUsed: false,
      qualityGate,
      sceneUnitBreakdown: this.buildSceneUnitBreakdown(semanticUnits),
    };
  }

  private buildSceneUnitBreakdown(
    semanticUnits: SceneSemanticUnit[],
  ): Record<string, number> {
    return semanticUnits.reduce<Record<string, number>>((acc, unit) => {
      acc[unit.type] = (acc[unit.type] || 0) + 1;
      return acc;
    }, {});
  }

  private countSynthesizedGlobalFields(
    synthesisResult: Partial<ScriptSynthesisResult> | null,
    analysisResult: ScriptAnalysisResult,
  ): number {
    const fields = [
      synthesisResult?.summary || analysisResult.summary,
      (synthesisResult?.themes || analysisResult.themes || []).join(','),
      (synthesisResult?.genres || analysisResult.genres || []).join(','),
      synthesisResult?.targetAudience || analysisResult.targetAudience,
      synthesisResult?.tone || analysisResult.tone,
      synthesisResult?.style || analysisResult.style,
      synthesisResult?.structure || analysisResult.structure,
      synthesisResult?.pacing || analysisResult.pacing,
      synthesisResult?.dialogue || analysisResult.dialogue,
      synthesisResult?.action || analysisResult.action,
      synthesisResult?.description || analysisResult.description,
      synthesisResult?.environmentalInfluence ||
        analysisResult.environmentalInfluence,
      synthesisResult?.conclusion || analysisResult.conclusion,
      synthesisResult?.relationship || analysisResult.relationship,
      synthesisResult?.subText || analysisResult.subText,
      synthesisResult?.coreThought || analysisResult.coreThought,
    ];

    return fields.filter((field) => typeof field === 'string' && field.trim())
      .length;
  }

  private evaluateSemanticQualityGate(
    totalScenes: number,
    totalSemanticUnits: number,
    sceneCoverageRatio: number,
    semanticUnitCoverageRatio: number,
    synthesizedGlobalFieldCount: number,
    synthesisSucceeded: boolean,
  ): SceneSemanticQualityGate {
    const minimumSceneCoverageRatio =
      this.getMinimumSceneCoverageRatio(totalScenes);
    const minimumSemanticUnitCoverageRatio =
      this.getMinimumSemanticUnitCoverageRatio(totalSemanticUnits);
    const minimumGlobalFieldCount =
      this.getMinimumGlobalFieldCount(totalScenes);
    const reasons: string[] = [];

    if (sceneCoverageRatio < minimumSceneCoverageRatio) {
      reasons.push(
        `Scene coverage ratio ${sceneCoverageRatio.toFixed(2)} is below required ${minimumSceneCoverageRatio.toFixed(2)}.`,
      );
    }

    if (semanticUnitCoverageRatio < minimumSemanticUnitCoverageRatio) {
      reasons.push(
        `Semantic unit coverage ratio ${semanticUnitCoverageRatio.toFixed(2)} is below required ${minimumSemanticUnitCoverageRatio.toFixed(2)}.`,
      );
    }

    if (!synthesisSucceeded) {
      reasons.push('Whole-script synthesis did not complete successfully.');
    }

    if (synthesizedGlobalFieldCount < minimumGlobalFieldCount) {
      reasons.push(
        `Only ${synthesizedGlobalFieldCount} global fields were populated; expected at least ${minimumGlobalFieldCount}.`,
      );
    }

    return {
      passed: reasons.length === 0,
      reasons,
      minimumSceneCoverageRatio,
      minimumSemanticUnitCoverageRatio,
      minimumGlobalFieldCount,
    };
  }

  private getMinimumSceneCoverageRatio(totalScenes: number): number {
    if (totalScenes <= 1) return 1;
    if (totalScenes <= 3) return 0.9;
    return 0.8;
  }

  private getMinimumSemanticUnitCoverageRatio(
    totalSemanticUnits: number,
  ): number {
    if (totalSemanticUnits <= 1) return 1;
    if (totalSemanticUnits <= 3) return 0.85;
    return 0.75;
  }

  private getMinimumGlobalFieldCount(totalScenes: number): number {
    return totalScenes <= 1 ? 5 : 7;
  }

  private buildFallbackSceneSummary(scene: ScriptParserScene): string {
    const characterCount = this.extractParserSceneCharacters(scene).length;
    const actionLines = scene.elements.filter(
      (element) => element.type === 'action',
    ).length;
    const dialogueLines = scene.elements.filter(
      (element) => element.type === 'dialogue',
    ).length;

    return `${scene.heading || `Scene ${scene.number}`} contains ${characterCount} identified character(s), ${dialogueLines} dialogue element(s), and ${actionLines} action element(s).`;
  }

  private extractScenePages(scene: ScriptParserScene): number[] {
    if (
      scene.page_start &&
      scene.page_end &&
      scene.page_end >= scene.page_start
    ) {
      return Array.from(
        { length: scene.page_end - scene.page_start + 1 },
        (_, index) => scene.page_start + index,
      );
    }

    return scene.page_start ? [scene.page_start] : [];
  }

  private extractParserSceneCharacters(scene: ScriptParserScene): string[] {
    return Array.from(
      new Set(
        scene.elements
          .map((element) => element.character_name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
  }

  private extractParserSceneDialogues(
    scene: ScriptParserScene,
  ): ScriptAnalysisResult['scenes'][0]['dialogues'] {
    const dialogues = scene.elements
      .filter((element) =>
        ['dialogue', 'action', 'parenthetical'].includes(element.type),
      )
      .map((element) => ({
        type:
          element.type === 'action' || element.type === 'parenthetical'
            ? element.type
            : 'dialogue',
        character:
          element.type === 'action' ? null : element.character_name || null,
        text: element.text,
      })) as ScriptAnalysisResult['scenes'][0]['dialogues'];

    return dialogues.length ? dialogues : undefined;
  }

  private collectKnownCharacterNames(
    parseResult: ScriptParserResultPayload,
    sceneCards: ScriptAnalysisResult['scenes'],
  ): string[] {
    return Array.from(
      new Set(
        [
          ...parseResult.characters.map((character) => character.name),
          ...sceneCards.flatMap((scene) => scene.characters),
        ]
          .map((name) => name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    );
  }

  private joinInsightValues(values?: Set<string>): string {
    if (!values?.size) return '';
    return Array.from(values).slice(0, 3).join(' ');
  }

  /**
   * Extract text from PDF using Gemini Vision API
   * Handles image-based PDFs and watermarked documents
   * @param pdfFilePath - Path to the PDF file
   * @returns Extracted text from the PDF
   */
  async extractTextFromPdf(
    pdfFilePath: string,
    userId?: string,
  ): Promise<string> {
    this.logger.log(
      `[Gemini Vision] Starting PDF text extraction via Gemini Vision API from: ${pdfFilePath}`,
    );

    if (!this.geminiProvider || !this.geminiProvider.isAvailable()) {
      this.logger.error(
        '[Gemini Vision] ✗ ERROR: Gemini provider is not configured or not available',
      );
      throw new Error(
        'Gemini provider is not configured. Set GOOGLE_GEMINI_API_KEY.',
      );
    }

    this.logger.log(
      '[Gemini Vision] Gemini provider is available and configured',
    );

    try {
      this.logger.debug(`[Gemini Vision] Reading PDF file: ${pdfFilePath}`);
      const fs = await import('fs/promises');
      const pdfBuffer = await fs.readFile(pdfFilePath);
      const pdfBase64 = pdfBuffer.toString('base64');
      this.logger.log(
        `[Gemini Vision] PDF file read. Size: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB, Base64 length: ${pdfBase64.length} characters`,
      );

      // Check file size (Gemini has limits)
      const maxFileSize = 20 * 1024 * 1024; // 20MB for inline data
      const fileSizeMB = pdfBuffer.length / 1024 / 1024;
      if (pdfBuffer.length > maxFileSize) {
        this.logger.warn(
          `[Gemini Vision] ⚠ WARNING: PDF file is large (${fileSizeMB.toFixed(2)}MB > ${maxFileSize / 1024 / 1024}MB limit). ` +
            `Consider using Gemini Files API for files > 20MB. Will attempt anyway...`,
        );
        // Still try, but may fail
      } else {
        this.logger.log(
          `[Gemini Vision] PDF file size OK (${fileSizeMB.toFixed(2)}MB <= ${maxFileSize / 1024 / 1024}MB)`,
        );
      }

      this.logger.debug('[Gemini Vision] Getting Gemini model instance...');
      const geminiModel = this.geminiProvider.getModel();
      this.logger.log('[Gemini Vision] Gemini model instance obtained');

      // Prepare extraction prompt with watermark handling instructions
      const extractionPrompt = `Extract all text from this PDF script document. 

IMPORTANT INSTRUCTIONS:
- Ignore any watermark overlays, tracking codes, or diagonal text that appears to be watermarks
- Focus on extracting script content:
  * Scene headings (INT./EXT./INTERIOR/EXTERIOR)
  * Character names (usually in ALL CAPS)
  * Dialogue (spoken lines)
  * Action lines (scene descriptions)
  * Transitions (CUT TO, FADE IN, etc.)
- Preserve the exact formatting and structure of the script
- Do not include watermark text in the extracted content
- Extract text line by line, maintaining the script's structure

Return the extracted text exactly as it appears in the script, without any additional commentary or formatting.`;

      // Invoke Gemini with PDF data
      // LangChain requires HumanMessage with content array for multimodal inputs
      this.logger.log(
        '[Gemini Vision] Preparing HumanMessage with PDF data and extraction prompt...',
      );

      const humanMessage = new HumanMessage({
        content: [
          {
            type: 'application/pdf',
            data: pdfBase64,
          },
          {
            type: 'text',
            text: extractionPrompt,
          },
        ],
      });

      this.logger.log(
        `[Gemini Vision] HumanMessage created. Content parts: PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(2)}MB) + Text prompt (${extractionPrompt.length} chars)`,
      );
      this.logger.log('[Gemini Vision] Invoking Gemini Vision API...');

      const apiCallStartTime = Date.now();
      const response = await withGeminiRetry(
        () => geminiModel.invoke([humanMessage]),
        'gemini_vision_extract',
      );
      const apiCallDuration = Date.now() - apiCallStartTime;

      this.persistGeminiUsageBestEffort(userId, response, 'gemini_vision_pdf');

      this.logger.log(
        `[Gemini Vision] ✓ API call completed in ${apiCallDuration}ms. Response received.`,
      );
      this.logger.debug(
        `[Gemini Vision] Response details - Type: ${typeof response}, Has content property: ${!!(response as any)?.content}, Response keys: ${Object.keys(response as any).join(', ')}`,
      );

      // Extract text from response
      // LangChain returns AIMessageChunk which has a content property
      this.logger.log('[Gemini Vision] Extracting text from API response...');
      let extractedText = '';

      if (typeof response === 'string') {
        this.logger.debug(
          '[Gemini Vision] Response is a string, using directly',
        );
        extractedText = response;
      } else if (response && typeof response === 'object') {
        this.logger.debug(
          '[Gemini Vision] Response is an object, parsing content...',
        );
        // Handle LangChain message format (AIMessageChunk)
        if (response.content !== undefined) {
          this.logger.debug(
            `[Gemini Vision] Response has content property. Content type: ${typeof response.content}, Is array: ${Array.isArray(response.content)}`,
          );
          // LangChain message format
          if (typeof response.content === 'string') {
            this.logger.debug(
              '[Gemini Vision] Content is a string, using directly',
            );
            extractedText = response.content;
          } else if (Array.isArray(response.content)) {
            this.logger.debug(
              `[Gemini Vision] Content is an array with ${response.content.length} parts. Extracting text from each part...`,
            );
            // Multiple content parts (can be text blocks or other content types)
            extractedText = response.content
              .map((part: any, index: number) => {
                if (typeof part === 'string') {
                  this.logger.debug(
                    `[Gemini Vision] Part ${index}: string (${part.length} chars)`,
                  );
                  return part;
                }
                if (part && typeof part === 'object') {
                  // Handle different content types
                  if (part.text) {
                    this.logger.debug(
                      `[Gemini Vision] Part ${index}: object with text property (${part.text.length} chars)`,
                    );
                    return part.text;
                  }
                  if (part.type === 'text' && part.text) {
                    this.logger.debug(
                      `[Gemini Vision] Part ${index}: object with type=text (${part.text.length} chars)`,
                    );
                    return part.text;
                  }
                  this.logger.debug(
                    `[Gemini Vision] Part ${index}: object without extractable text. Keys: ${Object.keys(part).join(', ')}`,
                  );
                  // For other content types, try to extract text
                  return '';
                }
                this.logger.debug(
                  `[Gemini Vision] Part ${index}: unknown type (${typeof part})`,
                );
                return '';
              })
              .filter((text: string) => text.length > 0)
              .join('\n');
            this.logger.debug(
              `[Gemini Vision] Extracted text from ${response.content.length} parts. Total length: ${extractedText.length} chars`,
            );
          }
        } else if ((response as any).text) {
          this.logger.debug(
            '[Gemini Vision] Response has text property directly, using it',
          );
          // Fallback: check for text property directly
          extractedText = (response as any).text;
        } else {
          // Last resort: try to stringify and log for debugging
          this.logger.error(
            `[Gemini Vision] ✗ ERROR: Unexpected response format. Response type: ${typeof response}, Response keys: ${Object.keys(response).join(', ')}, Response structure (first 1000 chars): ${JSON.stringify(response).substring(0, 1000)}`,
          );
          // Try to access content directly if it exists
          if ((response as any).content) {
            this.logger.warn(
              '[Gemini Vision] Attempting to convert content to string...',
            );
            extractedText = String((response as any).content);
          } else {
            this.logger.error(
              '[Gemini Vision] No extractable content found, stringifying entire response',
            );
            extractedText = JSON.stringify(response);
          }
        }
      } else {
        this.logger.error(
          `[Gemini Vision] ✗ ERROR: Response is neither string nor object. Type: ${typeof response}`,
        );
      }

      this.logger.log(
        `[Gemini Vision] Text extraction complete. Extracted length: ${extractedText.length} chars (raw), ${extractedText.trim().length} chars (trimmed)`,
      );

      if (!extractedText || extractedText.trim().length === 0) {
        this.logger.error(
          '[Gemini Vision] ✗ ERROR: Extracted text is empty or null. This may indicate:',
        );
        this.logger.error(
          '[Gemini Vision]   1. The PDF is corrupted or unreadable',
        );
        this.logger.error(
          '[Gemini Vision]   2. The PDF contains no extractable text',
        );
        this.logger.error(
          '[Gemini Vision]   3. There was an issue with the API call',
        );
        this.logger.error('[Gemini Vision]   4. The response parsing failed');
        throw new Error(
          'Gemini Vision API returned empty response. The PDF may be corrupted or unreadable.',
        );
      }

      const extractedLength = extractedText.trim().length;
      this.logger.log(
        `[Gemini Vision] ✓ SUCCESS: Extracted ${extractedLength} characters from PDF using Gemini Vision API`,
      );

      // Log a sample of the extracted text
      const sample = extractedText.trim().substring(0, 500);
      this.logger.debug(
        `[Gemini Vision] Sample of extracted text (first 500 chars): ${sample}...`,
      );

      if (extractedLength < 50) {
        this.logger.warn(
          `[Gemini Vision] ⚠ WARNING: Extracted very little text (${extractedLength} characters). This may indicate the PDF is mostly images or the extraction needs improvement.`,
        );
      }

      this.logger.log(
        '[Gemini Vision] ✓ PDF text extraction completed successfully',
      );
      return extractedText.trim();
    } catch (error: any) {
      // Log the full error for debugging
      this.logger.error(
        `Gemini Vision PDF extraction error: ${error.message || 'Unknown error'}`,
        error.stack || 'No stack trace',
      );

      // Handle specific error types
      if (
        error.message?.includes('GOOGLE_GEMINI_API_KEY') ||
        error.message?.includes('API key')
      ) {
        throw new Error(
          'Gemini API key not configured. Cannot use Vision fallback for PDF extraction.',
        );
      }

      if (error.message?.includes('quota') || error.status === 429) {
        throw new Error(
          'Gemini API quota exceeded. Please try again later or check your API limits.',
        );
      }

      if (error.message?.includes('invalid') || error.status === 400) {
        throw new Error(
          `Invalid PDF format or Gemini API request: ${error.message}`,
        );
      }

      if (error.message?.includes('timeout') || error.status === 504) {
        throw new Error(
          'Gemini Vision API request timed out. The PDF may be too large or complex.',
        );
      }

      if (
        error.message?.includes('PDF') ||
        error.message?.includes('document') ||
        error.message?.includes('file')
      ) {
        throw new Error(
          `PDF processing error: ${error.message}. The PDF may be corrupted or in an unsupported format.`,
        );
      }

      // Generic error with more context
      throw new Error(
        `Gemini Vision extraction failed: ${error.message || 'Unknown error'}. ` +
          `Error type: ${error.constructor?.name || 'Error'}, Status: ${error.status || 'N/A'}`,
      );
    }
  }

  /**
   * Check if an error is retryable (503, 429, network errors, etc.)
   */
  private classifySemanticFailure(error: any): SemanticFailureClass {
    const status =
      error?.status || error?.errorInfo?.status || error?.response?.status;
    const message = error?.message || error?.errorInfo?.message || '';

    if (message.includes('timed out after')) {
      return 'timeout';
    }

    if (
      message.includes('Unterminated string in JSON') ||
      message.includes('Unexpected token') ||
      (message.includes('JSON') &&
        (message.includes('parse') || message.includes('SyntaxError'))) ||
      (error?.name === 'SyntaxError' && message.includes('JSON'))
    ) {
      return 'malformed_structured_output';
    }

    if (
      error?.isUndefinedPropertyError ||
      error?.errorInfo?.isUndefinedPropertyError ||
      message.includes('Cannot read properties of undefined') ||
      message.includes("Cannot read property 'message' of undefined")
    ) {
      return 'langchain_internal';
    }

    if (status === 429) {
      return 'rate_limited';
    }

    return 'other';
  }

  private incrementSemanticFailure(
    telemetry: SemanticTelemetry,
    failureClass: SemanticFailureClass,
  ) {
    telemetry.skippedUnits += 1;

    switch (failureClass) {
      case 'timeout':
        telemetry.timeoutUnits += 1;
        break;
      case 'malformed_structured_output':
        telemetry.malformedStructuredOutputUnits += 1;
        break;
      case 'langchain_internal':
        telemetry.langchainInternalUnits += 1;
        break;
      case 'rate_limited':
        telemetry.rateLimitedUnits += 1;
        break;
      default:
        telemetry.otherFailedUnits += 1;
        break;
    }
  }

  private logSemanticTelemetry(
    status: 'success' | 'failed',
    telemetry: SemanticTelemetry,
    extras?: Record<string, any>,
  ) {
    this.logger.log(
      `[SemanticTelemetry] ${JSON.stringify({
        status,
        mode: telemetry.mode,
        title: telemetry.title,
        inputCharacters: telemetry.inputCharacters,
        totalUnits: telemetry.totalUnits,
        successfulUnits: telemetry.successfulUnits,
        skippedUnits: telemetry.skippedUnits,
        timeoutUnits: telemetry.timeoutUnits,
        malformedStructuredOutputUnits:
          telemetry.malformedStructuredOutputUnits,
        langchainInternalUnits: telemetry.langchainInternalUnits,
        rateLimitedUnits: telemetry.rateLimitedUnits,
        otherFailedUnits: telemetry.otherFailedUnits,
        ...(extras || {}),
      })}`,
    );
  }

  /**
   * Check if an error is retryable (503, 429, network errors, etc.)
   */
  private isRetryableError(error: any): boolean {
    const status =
      error?.status || error?.errorInfo?.status || error?.response?.status;
    const message = error?.message || error?.errorInfo?.message || '';

    // Retry on undefined property errors (LangChain internal errors that might be transient)
    if (
      error?.isUndefinedPropertyError ||
      error?.errorInfo?.isUndefinedPropertyError ||
      message.includes('Cannot read properties of undefined') ||
      message.includes("Cannot read property 'message' of undefined")
    ) {
      return true;
    }

    // Retry on 503 (Service Unavailable), 429 (Rate Limit), 500 (Internal Server Error)
    if (status === 503 || status === 429 || status === 500) {
      return true;
    }

    // Retry on network errors
    if (
      message.includes('ECONNRESET') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ENOTFOUND') ||
      message.includes('overloaded') ||
      message.includes('timeout')
    ) {
      return true;
    }

    // Retry on JSON parsing errors - these often happen when LLM generates malformed JSON
    // due to special characters in script content (quotes, newlines, etc.)
    if (
      message.includes('Unterminated string in JSON') ||
      message.includes('Unexpected token') ||
      (message.includes('JSON') &&
        (message.includes('parse') || message.includes('SyntaxError'))) ||
      (error?.name === 'SyntaxError' && message.includes('JSON'))
    ) {
      return true;
    }

    return false;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private currentBillingPeriod(): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { start, end };
  }

  /**
   * Fire-and-forget Gemini token metering: never throws, never rejects,
   * and does not affect script analysis if DB or parsing fails.
   * Failures are logged to the console for ops/debugging.
   */
  private persistGeminiUsageBestEffort(
    userId: string | undefined,
    invokeResult: unknown,
    context: string,
  ): void {
    if (!userId) {
      return;
    }
    void (async () => {
      try {
        const total = extractTotalTokensFromLangChainInvokeResult(invokeResult);
        if (total == null || total <= 0) {
          return;
        }
        let billingPeriodStart: Date;
        let billingPeriodEnd: Date;
        try {
          const p = this.currentBillingPeriod();
          billingPeriodStart = p.start;
          billingPeriodEnd = p.end;
        } catch (billingErr: unknown) {
          console.warn(
            '[GeminiTokenUsage] billing_period_failed',
            { context, userId },
            billingErr instanceof Error ? billingErr.message : billingErr,
          );
          return;
        }
        await this.usageRecordRepository.createEntity({
          userId,
          service: UsageService.GEMINI_TOKENS,
          quantity: total,
          unit: 'tokens',
          rehearsalId: null,
          recordingId: null,
          billingPeriodStart,
          billingPeriodEnd,
        } as any);
      } catch (err: unknown) {
        console.warn(
          '[GeminiTokenUsage] usage_record_persist_failed',
          { context, userId },
          err instanceof Error ? err.message : err,
          err instanceof Error && err.stack ? err.stack : '',
        );
      }
    })().catch((runnerErr: unknown) => {
      console.warn(
        '[GeminiTokenUsage] async_runner_failed',
        { context, userId },
        runnerErr instanceof Error ? runnerErr.message : runnerErr,
      );
    });
  }

  /**
   * Wrap LLM invocation with retry logic, timeout, and logging context
   */
  private async invokeWithTimeout(
    prompt: string,
    timeoutMs: number,
    context: string,
    userId?: string,
    maxRetries: number = 3,
    structuredModel: any = this.structuredLlm,
  ) {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `LLM call timed out after ${timeoutMs}ms (context=${context})`,
            ),
          ),
        timeoutMs,
      ),
    );

    // LangChain ChatGoogleGenerativeAI expects BaseMessage instances
    const messages = [new HumanMessage(prompt)];

    let lastError: any;
    const effectiveMaxRetries = maxRetries;

    // Retry loop
    for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Calculate backoff delay
          let backoffMs: number;

          // Check if last error was a rate limit (429) with retry delay info
          if (
            lastError?.status === 429 ||
            lastError?.errorInfo?.status === 429
          ) {
            // Try to extract retry delay from error message
            const errorMessage =
              lastError?.message || lastError?.errorInfo?.message || '';
            const retryDelayMatch = errorMessage.match(/retry in ([\d.]+)s/i);

            if (retryDelayMatch) {
              // Use the API-suggested retry delay (convert seconds to milliseconds)
              const retryDelaySeconds = parseFloat(retryDelayMatch[1]);
              backoffMs = Math.ceil(retryDelaySeconds * 1000);
              this.logger.warn(
                `Rate limit exceeded. Using API-suggested retry delay: ${retryDelaySeconds}s (context=${context}, attempt ${attempt + 1}/${maxRetries + 1})`,
              );
            } else {
              // Fallback to longer exponential backoff for rate limits: 60s, 120s, 180s
              backoffMs = Math.min(60000 * attempt, 180000);
              this.logger.warn(
                `Rate limit exceeded. Using exponential backoff: ${backoffMs / 1000}s (context=${context}, attempt ${attempt + 1}/${maxRetries + 1})`,
              );
            }
          } else {
            // Exponential backoff for other retryable errors: 2s, 4s, 8s
            backoffMs = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
            this.logger.warn(
              `Retrying LLM invocation (context=${context}, attempt ${attempt + 1}/${maxRetries + 1}) after ${backoffMs}ms`,
            );
          }

          await this.sleep(backoffMs);
        }

        this.logger.debug(
          `Invoking structured LLM (context=${context}, attempt ${attempt + 1}/${maxRetries + 1}, prompt length=${prompt.length})`,
        );

        // Wrap the invoke call to catch any errors before they reach LangChain's error handler
        // LangChain sometimes throws undefined errors, so we need to catch them defensively
        // We use a Promise wrapper to ensure all rejections have proper error objects
        const invokePromise = new Promise(async (resolve, reject) => {
          // Set up a handler to catch any unhandled rejections from the invoke call
          const originalUnhandledRejection =
            process.listeners('unhandledRejection');

          const rejectionHandler = (reason: any, promise: Promise<any>) => {
            // If the rejection reason is undefined, create a proper error
            if (reason === undefined || reason === null) {
              const error = new Error(
                'LLM invocation rejected with undefined - likely a LangChain internal issue',
              );
              (error as any).isUndefinedRejection = true;
              reject(error);
              return;
            }
            // If it's already an error, reject with it
            if (reason instanceof Error) {
              reject(reason);
              return;
            }
            // Otherwise, wrap it in an Error
            reject(new Error(`LLM invocation failed: ${String(reason)}`));
          };

          // Temporarily add our handler (will be removed after invoke completes)
          process.once('unhandledRejection', rejectionHandler);

          try {
            const result = await structuredModel.invoke(messages);
            // Remove our handler if invoke succeeds
            process.removeListener('unhandledRejection', rejectionHandler);
            resolve(result);
          } catch (invokeError: any) {
            // Remove our handler
            process.removeListener('unhandledRejection', rejectionHandler);

            // If the error is undefined, create a proper error object
            if (
              invokeError === undefined ||
              invokeError === null ||
              !invokeError
            ) {
              reject(
                new Error(
                  'LLM invocation failed with undefined error - likely a LangChain internal issue. This may occur with very large PDFs or complex content.',
                ),
              );
              return;
            }
            reject(invokeError);
          }
        }).catch((catchError: any) => {
          // Final catch to ensure we never reject with undefined
          if (catchError === undefined || catchError === null || !catchError) {
            throw new Error(
              'LLM invocation failed with undefined error in final catch',
            );
          }
          throw catchError;
        });

        // Wrap invokePromise with additional error handling
        const wrappedInvokePromise = invokePromise.catch((invokeError: any) => {
          // Handle cases where error might be undefined or malformed
          if (
            !invokeError ||
            invokeError === undefined ||
            invokeError === null
          ) {
            const undefinedError = new Error(
              'LLM invocation failed with undefined error - likely a transient API issue or LangChain internal error',
            );
            (undefinedError as any).errorInfo = {
              message:
                'Undefined error from LangChain - possibly internal error handling issue. This may occur with very large PDFs or complex content.',
              name: 'TypeError',
              isUndefinedError: true,
            };
            throw undefinedError;
          }

          // If this error is already an enhanced error (has errorInfo), don't re-wrap it
          if (invokeError.errorInfo) {
            // Already enhanced, just re-throw
            throw invokeError;
          }

          // Check if this is the "Cannot read properties of undefined" error
          const errorMessage =
            invokeError?.message || String(invokeError) || 'Unknown error';
          const isUndefinedPropertyError =
            errorMessage.includes('Cannot read properties of undefined') ||
            errorMessage.includes(
              "Cannot read property 'message' of undefined",
            );

          // Get the original error (might be nested)
          const originalError =
            invokeError?.originalError || invokeError?.cause || invokeError;

          // Catch and re-throw with better error information
          const errorInfo = {
            message: errorMessage,
            name: invokeError?.name || 'Unknown',
            cause: originalError,
            response: invokeError?.response,
            status: invokeError?.status,
            statusText: invokeError?.statusText,
            code: invokeError?.code,
            details: invokeError?.details,
            stack: invokeError?.stack?.substring(0, 1000),
            isUndefinedPropertyError,
          };

          this.logger.error(
            `Structured LLM invoke failed (context=${context}, attempt ${attempt + 1}): ${JSON.stringify(errorInfo, null, 2)}`,
          );

          // Create a proper error object (avoid nesting if already enhanced)
          const enhancedError = new Error(
            `LLM invocation failed: ${errorInfo?.message || 'Unknown error'}`,
          );
          (enhancedError as any).originalError = originalError;
          (enhancedError as any).errorInfo = errorInfo;
          (enhancedError as any).isUndefinedPropertyError =
            isUndefinedPropertyError;
          throw enhancedError;
        });

        const result = await Promise.race([
          wrappedInvokePromise,
          timeoutPromise,
        ]);

        this.logger.debug(
          `Structured LLM invocation successful (context=${context}, attempt ${attempt + 1})`,
        );
        this.persistGeminiUsageBestEffort(userId, result, context);
        return result;
      } catch (error: any) {
        lastError = error;

        // Check if error is retryable and we have retries left
        const status = error?.status || error?.errorInfo?.status;
        const errorMessage =
          error?.message || error?.errorInfo?.message || 'Unknown error';
        const errorName = error?.name || error?.errorInfo?.name || '';

        // For rate limit errors, allow more retries (up to 5) since they often just need time
        const maxRetriesForThisError =
          status === 429
            ? Math.max(effectiveMaxRetries, 5)
            : effectiveMaxRetries;

        if (attempt < maxRetriesForThisError && this.isRetryableError(error)) {
          // Special handling for different error types
          if (status === 429) {
            if (
              errorMessage.includes('quota') ||
              errorMessage.includes('Quota exceeded')
            ) {
              this.logger.error(
                `Gemini API quota exceeded (context=${context}, attempt ${attempt + 1}/${maxRetries + 1}). This may indicate you've reached your daily free tier limit (20 requests/day for free tier). Consider upgrading your API plan or waiting until the quota resets.`,
              );
            } else {
              this.logger.warn(
                `Rate limit error encountered (context=${context}, attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage.substring(0, 200)}`,
              );
            }
          } else if (
            errorName === 'SyntaxError' &&
            errorMessage.includes('JSON')
          ) {
            // JSON parsing errors - often caused by unescaped special characters in script content
            this.logger.warn(
              `JSON parsing error (context=${context}, attempt ${attempt + 1}/${maxRetries + 1}). This usually means the LLM generated invalid JSON due to special characters in the script. Retrying with improved prompt... Error: ${errorMessage.substring(0, 200)}`,
            );
          } else {
            this.logger.warn(
              `Retryable error encountered (context=${context}, attempt ${attempt + 1}/${maxRetries + 1}): ${errorMessage.substring(0, 200)}`,
            );
          }
          continue; // Retry
        }

        // If not retryable or out of retries, break and throw
        break;
      }
    }

    // If we get here, all retries failed
    const errorDetails = {
      message: lastError?.message,
      name: lastError?.name,
      stack: lastError?.stack?.substring(0, 500),
      originalError: lastError?.originalError,
      errorInfo: lastError?.errorInfo,
      cause: lastError?.cause,
      response: lastError?.response,
      status: lastError?.status,
      statusText: lastError?.statusText,
      code: lastError?.code,
      details: lastError?.details,
    };

    this.logger.error(
      `LLM invoke error after ${maxRetries + 1} attempts (context=${context}): ${JSON.stringify(errorDetails, null, 2)}`,
    );

    // Re-throw with more context
    const errorMessage =
      lastError?.message ||
      lastError?.errorInfo?.message ||
      lastError?.toString() ||
      'Unknown error during LLM invocation';
    throw new Error(
      `LLM invocation failed after ${maxRetries + 1} attempts (${context}): ${errorMessage}`,
    );
  }

  /**
   * Merge results from multiple chunks
   */
  private mergeChunkResults(
    chunkResults: Partial<ScriptAnalysisResult>[],
    title: string,
  ): ScriptAnalysisResult {
    const merged: ScriptAnalysisResult = {
      summary: '',
      characters: [],
      scenes: [],
      themes: [],
      confidenceScore: 0,
      genres: [],
      targetAudience: '',
      tone: '',
      style: '',
      structure: '',
      pacing: '',
      dialogue: '',
      action: '',
      description: '',
      environmentalInfluence: '',
      conclusion: '',
      relationship: '',
      subText: '',
      coreThought: '',
    };

    const characterMap = new Map<
      string,
      ScriptAnalysisResult['characters'][0]
    >();
    const sceneMap = new Map<number, any>();
    const themeSet = new Set<string>();
    const genreSet = new Set<string>();

    // Normalize a genre string: strip parenthetical qualifications and trim
    const normalizeGenre = (g: string): string =>
      g.replace(/\s*\(.*?\)\s*/g, '').trim();

    // Merge all chunks
    for (const chunk of chunkResults) {
      // Merge characters (deduplicate by name case-insensitively, merge all character fields)
      if (chunk.characters) {
        for (const char of chunk.characters) {
          const key = char.name.trim().toUpperCase();
          if (!characterMap.has(key)) {
            characterMap.set(key, {
              name: char.name,
              description: char.description || '',
              background: char.background || '',
              definingPersonalityTraits: char.definingPersonalityTraits || '',
              perception: char.perception || '',
              goalAndConflict: char.goalAndConflict || '',
              emotionalArc: char.emotionalArc || '',
              relationships: char.relationships || '',
              subtextAndCoreTruth: char.subtextAndCoreTruth || '',
            });
          } else {
            // Merge additional fields if they exist in the new chunk but not in the existing one
            const existing = characterMap.get(key)!;
            if (!existing.background && char.background) {
              existing.background = char.background;
            }
            if (
              !existing.definingPersonalityTraits &&
              char.definingPersonalityTraits
            ) {
              existing.definingPersonalityTraits =
                char.definingPersonalityTraits;
            }
            if (!existing.perception && char.perception) {
              existing.perception = char.perception;
            }
            if (!existing.goalAndConflict && char.goalAndConflict) {
              existing.goalAndConflict = char.goalAndConflict;
            }
            if (!existing.emotionalArc && char.emotionalArc) {
              existing.emotionalArc = char.emotionalArc;
            }
            if (!existing.relationships && char.relationships) {
              existing.relationships = char.relationships;
            }
            if (!existing.subtextAndCoreTruth && char.subtextAndCoreTruth) {
              existing.subtextAndCoreTruth = char.subtextAndCoreTruth;
            }
          }
        }
      }

      // Merge scenes (deduplicate by number, merge dialogues)
      if (chunk.scenes) {
        for (const scene of chunk.scenes) {
          if (!sceneMap.has(scene.number)) {
            sceneMap.set(scene.number, scene);
          } else {
            // Merge dialogues in script order (append new entries after existing, preserve sequence)
            const existingScene = sceneMap.get(scene.number)!;
            if (Array.isArray(scene.dialogues) && scene.dialogues.length > 0) {
              if (
                Array.isArray(existingScene.dialogues) &&
                existingScene.dialogues.length > 0
              ) {
                // Append new dialogue entries after existing ones to preserve script order
                const combined = [
                  ...existingScene.dialogues.filter(
                    (d) => d != null && d.text != null,
                  ),
                  ...scene.dialogues.filter((d) => d != null && d.text != null),
                ];
                existingScene.dialogues = combined;
              } else {
                // Existing scene has no dialogues, use new ones
                existingScene.dialogues = scene.dialogues;
              }
            }
          }
        }
      }

      // Merge themes
      if (chunk.themes) {
        chunk.themes.forEach((t) => themeSet.add(t));
      }

      // Merge genres (normalize to strip parenthetical qualifications)
      if (chunk.genres) {
        chunk.genres.forEach((g) => {
          const normalized = normalizeGenre(g);
          if (normalized) genreSet.add(normalized);
        });
      }

      // Use first non-empty values for other fields
      if (chunk.summary && !merged.summary) merged.summary = chunk.summary;
      if (chunk.targetAudience && !merged.targetAudience)
        merged.targetAudience = chunk.targetAudience;
      if (chunk.tone && !merged.tone) merged.tone = chunk.tone;
      if (chunk.style && !merged.style) merged.style = chunk.style;
      if (chunk.structure && !merged.structure)
        merged.structure = chunk.structure;
      if (chunk.pacing && !merged.pacing) merged.pacing = chunk.pacing;
      if (chunk.dialogue && !merged.dialogue) merged.dialogue = chunk.dialogue;
      if (chunk.action && !merged.action) merged.action = chunk.action;
      if (chunk.description && !merged.description)
        merged.description = chunk.description;
      if (chunk.environmentalInfluence && !merged.environmentalInfluence)
        merged.environmentalInfluence = chunk.environmentalInfluence;
      if (chunk.conclusion && !merged.conclusion)
        merged.conclusion = chunk.conclusion;
      if (chunk.relationship && !merged.relationship)
        merged.relationship = chunk.relationship;
      if (chunk.subText && !merged.subText) merged.subText = chunk.subText;
      if (chunk.coreThought && !merged.coreThought)
        merged.coreThought = chunk.coreThought;
      if (chunk.confidenceScore && !merged.confidenceScore)
        merged.confidenceScore = chunk.confidenceScore;
    }

    // Convert maps/sets to arrays
    merged.characters = Array.from(characterMap.values());

    merged.scenes = Array.from(sceneMap.values()).sort(
      (a, b) => a.number - b.number,
    );

    merged.themes = Array.from(themeSet);
    merged.genres = Array.from(genreSet);

    // Generate summary if missing
    if (!merged.summary) {
      merged.summary = `Script analysis completed. Found ${merged.characters.length} characters and ${merged.scenes.length} scenes.`;
    }

    return merged;
  }

  /**
   * Validate and normalize the analysis result
   */
  private validateAndNormalizeAnalysis(
    parsed: any,
    fallbackTitle: string,
  ): ScriptAnalysisResult {
    const normalizeGenre = (g: string): string =>
      g.replace(/\s*\(.*?\)\s*/g, '').trim();

    const result: ScriptAnalysisResult = {
      summary: parsed.summary || '',
      characters: [],
      scenes: [],
      themes: parsed.themes || [],
      confidenceScore: parsed.confidenceScore || 0.95,
      genres: Array.isArray(parsed.genres)
        ? ([
            ...new Set(
              (parsed.genres as string[]).map(normalizeGenre).filter(Boolean),
            ),
          ] as string[])
        : [],
      targetAudience: parsed.targetAudience || '',
      tone: parsed.tone || '',
      style: parsed.style || '',
      structure: parsed.structure || '',
      pacing: parsed.pacing || '',
      dialogue: parsed.dialogue || '',
      action: parsed.action || '',
      description: parsed.description || '',
      environmentalInfluence: parsed.environmentalInfluence || '',
      conclusion: parsed.conclusion || '',
      relationship: parsed.relationship || '',
      subText: parsed.subText || '',
      coreThought: parsed.coreThought || '',
    };

    // Validate and normalize characters
    if (Array.isArray(parsed.characters)) {
      result.characters = parsed.characters
        .filter((char: any) => char && typeof char.name === 'string')
        .map((char: any) => ({
          name: char.name.trim(),
          description:
            typeof char.description === 'string' ? char.description.trim() : '',
          background:
            typeof char.background === 'string' ? char.background.trim() : '',
          definingPersonalityTraits:
            typeof char.definingPersonalityTraits === 'string'
              ? char.definingPersonalityTraits.trim()
              : '',
          perception:
            typeof char.perception === 'string' ? char.perception.trim() : '',
          goalAndConflict:
            typeof char.goalAndConflict === 'string'
              ? char.goalAndConflict.trim()
              : '',
          emotionalArc:
            typeof char.emotionalArc === 'string'
              ? char.emotionalArc.trim()
              : '',
          relationships:
            typeof char.relationships === 'string'
              ? char.relationships.trim()
              : '',
          subtextAndCoreTruth:
            typeof char.subtextAndCoreTruth === 'string'
              ? char.subtextAndCoreTruth.trim()
              : '',
        }));
    }

    // Validate and normalize scenes
    if (Array.isArray(parsed.scenes)) {
      result.scenes = parsed.scenes
        .filter((scene: any) => scene && typeof scene.number === 'number')
        .map((scene: any) => ({
          number: scene.number,
          heading:
            typeof scene.heading === 'string' ? scene.heading.trim() : '',
          summary:
            typeof scene.summary === 'string' ? scene.summary.trim() : '',
          pages: Array.isArray(scene.pages)
            ? scene.pages.filter((p: any) => typeof p === 'number')
            : [],
          characters: Array.isArray(scene.characters)
            ? scene.characters
                .filter((name: any) => typeof name === 'string')
                .map((name: string) => name.trim())
            : [],
          // Preserve dialogues if present
          dialogues: Array.isArray(scene.dialogues)
            ? scene.dialogues
                .filter(
                  (d: any) =>
                    d &&
                    typeof d.text === 'string' &&
                    ['dialogue', 'action', 'parenthetical'].includes(
                      d.type || 'dialogue',
                    ),
                )
                .map((d: any) => ({
                  type:
                    d.type === 'action' || d.type === 'parenthetical'
                      ? d.type
                      : 'dialogue',
                  character:
                    typeof d.character === 'string' ? d.character.trim() : null,
                  text: d.text.trim(),
                }))
            : undefined,
        }))
        .sort((a, b) => a.number - b.number);
    }

    return result;
  }
}
