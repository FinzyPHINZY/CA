import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  AiScriptAnalysisDTO,
  MediaService,
  ProjectRepository,
  CharacterRepository,
  SceneRepository,
} from '@app/common';
import { AiOrchestratorService } from './modules/ai-orchestrator/ai-orchestrator.service';
import { ScriptParserResultMessage } from './contracts/script-parser.contract';

@Injectable()
export class AiServiceService {
  private readonly logger = new Logger(AiServiceService.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly orchestratorService: AiOrchestratorService,
    private readonly projectRepository: ProjectRepository,
    private readonly characterRepository: CharacterRepository,
    private readonly sceneRepository: SceneRepository,
  ) {}

  getHello(): string {
    return 'Hello from ACR AI Service!';
  }

  /**
   * Analyze a script using AI with progress updates
   * Uses Gemini AI to extract script data and save to database
   */
  async analyzeScriptWithProgress(
    payload: AiScriptAnalysisDTO,
    onProgress: (progress: number, message: string, step?: string) => void,
  ): Promise<{
    scriptId: string;
    summary: string;
    characters: Array<{
      name: string;
      description: string;
      background?: string;
      definingPersonalityTraits?: string;
      perception?: string;
      goalAndConflict?: string;
      emotionalArc?: string;
      relationships?: string;
      subtextAndCoreTruth?: string;
    }>;
    scenes: Array<{
      number: number;
      heading: string;
      summary: string;
      pages: number[];
      characters: string[];
    }>;
    themes: string[];
    confidenceScore: number;
    genres: string[];
    targetAudience: string;
    tone: string;
    style: string;
    structure: string;
    pacing: string;
    dialogue: string;
    action: string;
    description: string;
    environmentalInfluence: string;
    conclusion: string;
    relationship: string;
    subText: string;
    coreThought: string;
    analysisLifecycle?: Record<string, any>;
  }> {
    const { taskId, projectId, userId, mediaId } = payload;

    // Fetch media information
    const media = await this.mediaService.findById(mediaId);
    if (!media) {
      throw new NotFoundException(`Media with ID ${mediaId} not found`);
    }

    this.logger.log(
      `Starting script analysis for project ${projectId}, task ${taskId}, media ${mediaId}`,
    );

    try {
      // Get project for fallback title only (READ ONLY - project title is never modified during analysis)
      const project = await this.projectRepository.findById(projectId);
      // Use file name as script name; fall back to project title only if file name is missing
      const scriptTitle = media.fileName || project?.title || 'Untitled Script';

      // Use orchestrator to analyze script and save to database
      // Pass taskId and projectId so it can find and update the existing script
      const savedData = await this.orchestratorService.analyzeScript(
        media.url,
        media.fileName,
        userId,
        scriptTitle,
        taskId,
        projectId,
        onProgress,
      );
      return this.buildAnalysisResponse(taskId, savedData, onProgress);
    } catch (error: any) {
      this.logger.error(
        `Script analysis failed for task ${taskId}: ${error.message}`,
        error.stack,
      );

      // Re-throw with proper error type
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      throw new BadRequestException(`Script analysis failed: ${error.message}`);
    }
  }

  async analyzeParsedScriptWithProgress(
    payload: ScriptParserResultMessage,
    onProgress: (progress: number, message: string, step?: string) => void,
  ) {
    const { task_id: taskId, project_id: projectId, user_id: userId } = payload;
    if (!projectId) {
      throw new BadRequestException(
        'Parser result is missing project_id correlation',
      );
    }
    if (!payload.result?.clean_text?.trim()) {
      throw new BadRequestException(
        'Parser result is missing clean_text for semantic analysis',
      );
    }

    this.logger.log(
      `Starting parser-first semantic analysis for project ${projectId}, task ${taskId}`,
    );

    const project = await this.projectRepository.findById(projectId);
    const scriptTitle =
      payload.file_name ||
      payload.result.title ||
      project?.title ||
      'Untitled Script';

    const savedData = await this.orchestratorService.analyzeScriptFromCleanText(
      payload.result,
      payload.native_extraction || null,
      scriptTitle,
      taskId,
      userId,
      projectId,
      onProgress,
    );

    return this.buildAnalysisResponse(taskId, savedData, onProgress);
  }

  async debugExtractScript(
    mediaUrl: string,
    fileName: string | null,
  ): Promise<any> {
    return this.orchestratorService.debugExtract(mediaUrl, fileName);
  }

  /**
   * Helper method to simulate delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildAnalysisResponse(
    taskId: string,
    savedData: {
      scriptId: string;
      characters: Array<{ id: string; name: string }>;
      scenes: Array<{ id: string; number: number }>;
      analysisResult: any;
      analysisLifecycle?: Record<string, any>;
    },
    onProgress?: (progress: number, message: string, step?: string) => void,
  ) {
    const characterIdMap = new Map<string, string>();
    if (savedData.characters && Array.isArray(savedData.characters)) {
      savedData.characters.forEach((char: { id: string; name: string }) => {
        if (char.id && char.name) {
          characterIdMap.set(char.name, char.id);
        }
      });
    }

    const characters = savedData.analysisResult.characters.map((c) => ({
      id: characterIdMap.get(c.name) || null,
      name: c.name,
      description: c.description || '',
      background: c.background || '',
      definingPersonalityTraits: c.definingPersonalityTraits || '',
      perception: c.perception || '',
      goalAndConflict: c.goalAndConflict || '',
      emotionalArc: c.emotionalArc || '',
      relationships: c.relationships || '',
      subtextAndCoreTruth: c.subtextAndCoreTruth || '',
    }));

    const scenes = savedData.analysisResult.scenes.map((s) => ({
      number: s.number,
      heading: s.heading || '',
      summary: s.summary || '',
      pages: s.pages || [],
      characters: s.characters || [],
    }));

    const result = {
      scriptId: savedData.scriptId,
      summary: savedData.analysisResult.summary || '',
      characters,
      scenes,
      themes: savedData.analysisResult.themes || [],
      confidenceScore: savedData.analysisResult.confidenceScore || 0.95,
      genres: savedData.analysisResult.genres || [],
      targetAudience: savedData.analysisResult.targetAudience || '',
      tone: savedData.analysisResult.tone || '',
      style: savedData.analysisResult.style || '',
      structure: savedData.analysisResult.structure || '',
      pacing: savedData.analysisResult.pacing || '',
      dialogue: savedData.analysisResult.dialogue || '',
      action: savedData.analysisResult.action || '',
      description: savedData.analysisResult.description || '',
      environmentalInfluence:
        savedData.analysisResult.environmentalInfluence || '',
      conclusion: savedData.analysisResult.conclusion || '',
      relationship: savedData.analysisResult.relationship || '',
      subText: savedData.analysisResult.subText || '',
      coreThought: savedData.analysisResult.coreThought || '',
      analysisLifecycle: savedData.analysisLifecycle || null,
    };

    onProgress?.(100, 'Analysis complete!', 'completed');
    this.logger.log(`Script analysis completed for task ${taskId}`);

    return result;
  }
}
