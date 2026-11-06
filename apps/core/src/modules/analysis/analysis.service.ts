/** biome-ignore-all lint/style/useImportType: <> */

import { randomUUID } from 'node:crypto';
import { AI_SERVICE, CharacterRepository } from '@app/common';
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { StartAnalysisDto } from './dto/start-analysis.dto';
import {
  AnalysisStatus,
  ScriptAnalysis,
} from './entities/script-analysis.entity';
import { ScriptAnalysisRepository } from './repositories/script-analysis.repository';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @Inject(AI_SERVICE) private readonly aiClient: ClientProxy,
    private readonly analysisRepository: ScriptAnalysisRepository,
    private readonly characterRepository: CharacterRepository,
  ) {}

  /**
   * Start an analysis task
   */
  async startAnalysis(
    userId: string,
    dto: StartAnalysisDto,
  ): Promise<{
    success: boolean;
    message: string;
    data: { taskId: string; userId: string };
  }> {
    const taskId = randomUUID();

    this.logger.log(
      `Starting analysis task ${taskId} for user ${userId}, script ${dto.scriptId}`,
    );

    // Create initial task record in database
    const analysis = await this.analysisRepository.createAnalysis({
      taskId,
      userId,
      scriptId: dto.scriptId,
      status: AnalysisStatus.PENDING,
    });

    try {
      // Send analysis job to AI service via RabbitMQ
      await firstValueFrom(
        this.aiClient.send('ai.analyze', {
          taskId,
          userId,
          scriptId: dto.scriptId,
          scriptContent: dto.scriptContent,
        }),
      );

      // Update status to processing
      await this.analysisRepository.updateAnalysis(analysis.id, {
        status: AnalysisStatus.PROCESSING,
      });

      this.logger.log(`Analysis task ${taskId} sent to AI service`);

      return {
        success: true,
        message:
          'Analysis started. Connect to WebSocket to receive progress updates.',
        data: { taskId, userId },
      };
    } catch (error) {
      this.logger.error(
        `Failed to start analysis task ${taskId}: ${error.message}`,
        error.stack,
      );

      // Update status to failed
      await this.analysisRepository.updateAnalysis(analysis.id, {
        status: AnalysisStatus.FAILED,
        error: error.message,
        completedAt: new Date(),
      });

      throw new InternalServerErrorException(
        'Failed to queue analysis job. Please try again.',
      );
    }
  }

  /**
   * Get analysis results by taskId
   */
  async getAnalysisResults(
    taskId: string,
    userId: string,
  ): Promise<{ success: boolean; message: string; data: ScriptAnalysis }> {
    const result = await this.analysisRepository.findByTaskIdAndUserId(
      taskId,
      userId,
    );

    if (!result) {
      throw new NotFoundException(`Analysis task ${taskId} not found`);
    }

    // Enrich characters with IDs if missing (backward compatibility)
    if (
      result.scriptId &&
      result.characters &&
      Array.isArray(result.characters)
    ) {
      const scriptId = result.scriptId;
      const charactersWithIds = await Promise.all(
        result.characters.map(async (char: any) => {
          // If character already has an ID and isMinor is set, return as is
          if (char.id) {
            return { ...char, isMinor: false };
          }

          // Otherwise, try to find the character by scriptId and name (case-insensitive)
          try {
            const character =
              await this.characterRepository.findByScriptIdAndName(
                scriptId,
                char.name,
              );
            if (character) {
              return {
                ...char,
                id: character.id,
                isMinor: false,
              };
            }
          } catch (error) {
            this.logger.warn(
              `Failed to find character ID for ${char.name} in script ${scriptId}: ${error.message}`,
            );
          }

          // No DB entity — minor/background character
          return { ...char, id: null, isMinor: true };
        }),
      );

      // Update the result with enriched characters
      result.characters = charactersWithIds;
    }

    return {
      success: true,
      message: 'Analysis results retrieved successfully',
      data: result,
    };
  }

  /**
   * Store analysis result (called by AI service when analysis completes)
   */
  async storeAnalysisResult(
    taskId: string,
    result: {
      summary: string;
      characters: Array<{ name: string; description: string }>;
      scenes: Array<{
        number: number;
        heading: string;
        summary: string;
        pages: number[];
        characters: string[];
        dialogues?: Array<{
          characterId?: string;
          characterName: string;
          text: string;
        }>;
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
    },
    status: AnalysisStatus = AnalysisStatus.COMPLETED,
    error?: string,
  ): Promise<ScriptAnalysis | null> {
    const analysis = await this.analysisRepository.findByTaskId(taskId);
    if (!analysis) {
      this.logger.warn(`Analysis task ${taskId} not found when storing result`);
      return null;
    }

    const updateData: Partial<ScriptAnalysis> = {
      status,
      summary: result.summary,
      characters: result.characters,
      scenes: result.scenes,
      themes: result.themes,
      genres: result.genres,
      targetAudience: result.targetAudience,
      tone: result.tone,
      style: result.style,
      structure: result.structure,
      pacing: result.pacing,
      dialogue: result.dialogue,
      action: result.action,
      description: result.description,
      environmentalInfluence: result.environmentalInfluence,
      conclusion: result.conclusion,
      relationship: result.relationship,
      subText: result.subText,
      coreThought: result.coreThought,
      aiConfidenceScore: result.confidenceScore,
      error: error || null,
      completedAt: new Date(),
    };

    return this.analysisRepository.updateAnalysis(analysis.id, updateData);
  }

  /**
   * Update analysis status (called when receiving progress/completion events)
   */
  async updateAnalysisStatus(
    taskId: string,
    status: AnalysisStatus,
    error?: string,
  ): Promise<ScriptAnalysis | null> {
    const analysis = await this.analysisRepository.findByTaskId(taskId);
    if (!analysis) {
      this.logger.warn(
        `Analysis task ${taskId} not found when updating status`,
      );
      return null;
    }

    const updateData: Partial<ScriptAnalysis> = {
      status,
      error: error || null,
    };

    if (
      status === AnalysisStatus.COMPLETED ||
      status === AnalysisStatus.FAILED
    ) {
      updateData.completedAt = new Date();
    }

    return this.analysisRepository.updateAnalysis(analysis.id, updateData);
  }
}
