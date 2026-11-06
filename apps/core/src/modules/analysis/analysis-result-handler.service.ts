import { Injectable, Inject, Logger, Controller } from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  Payload,
  Ctx,
  RmqContext,
} from '@nestjs/microservices';
import { ScriptAnalysisRepository } from './repositories/script-analysis.repository';
import {
  ScriptAnalysis,
  AnalysisStatus,
} from './entities/script-analysis.entity';
import {
  AI_SERVICE,
  ScriptRepository,
  ProjectRepository,
  ScriptStatus,
  ProjectStatus,
} from '@app/common';
import { SCRIPT_QA_EVENTS } from '@app/common';

/**
 * Service to handle analysis completion events from RabbitMQ
 * This service listens for completion events and stores results in the database
 * Script failures are kept at the script level; projects remain intact.
 */
@Controller()
@Injectable()
export class AnalysisResultHandlerService {
  private readonly logger = new Logger(AnalysisResultHandlerService.name);

  constructor(
    private readonly analysisRepository: ScriptAnalysisRepository,
    private readonly scriptRepository: ScriptRepository,
    private readonly projectRepository: ProjectRepository,
    @Inject(AI_SERVICE) private readonly aiClient: ClientProxy,
  ) {}

  /**
   * Handle analysis result storage from AI service
   * This is called via RabbitMQ when AI service completes analysis
   */
  @EventPattern('analysis.result.store')
  async handleAnalysisResult(
    @Payload()
    payload: {
      taskId: string;
      userId: string;
      scriptId?: string;
      result?: any;
      status: 'success' | 'failed';
      error?: string;
      errorCode?: string;
      resultMetadata?: any;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Storing analysis result for task ${payload.taskId}`);

    try {
      const analysis = await this.analysisRepository.findByTaskId(
        payload.taskId,
      );

      let analysisRecord = analysis;

      // If not found, create a record (for project-created analyses that didn't
      // go through /analysis/start)
      if (!analysisRecord) {
        if (!payload.scriptId) {
          this.logger.warn(
            `Analysis task ${payload.taskId} missing analysis record and scriptId; cannot create entry`,
          );
          const channel = context.getChannelRef();
          const originalMessage = context.getMessage();
          channel.ack(originalMessage);
          return;
        }

        this.logger.log(
          `Creating analysis record for task ${payload.taskId} (scriptId=${payload.scriptId})`,
        );
        try {
          analysisRecord = await this.analysisRepository.createAnalysis({
            taskId: payload.taskId,
            userId: payload.userId,
            scriptId: payload.scriptId,
            status: AnalysisStatus.PENDING,
          });
        } catch (error: any) {
          // Concurrent duplicate-delivery race: another invocation for the
          // same taskId inserted between our findByTaskId() and createAnalysis().
          // Postgres unique-violation = 23505. Fetch the existing row instead.
          const pgCode = error?.code ?? error?.driverError?.code;
          if (pgCode === '23505') {
            this.logger.warn(
              `Concurrent insert for task ${payload.taskId} — fetching existing record`,
            );
            analysisRecord = await this.analysisRepository.findByTaskId(
              payload.taskId,
            );
            if (!analysisRecord) {
              throw error;
            }
          } else {
            throw error;
          }
        }
      }

      const updateData: Partial<ScriptAnalysis> = {
        status:
          payload.status === 'success'
            ? AnalysisStatus.COMPLETED
            : AnalysisStatus.FAILED,
        error: payload.error || null,
        completedAt: new Date(),
      };

      // If result is provided, store all analysis data
      if (payload.result && payload.status === 'success') {
        updateData.summary = payload.result.summary;
        updateData.characters = payload.result.characters;
        updateData.scenes = payload.result.scenes;
        updateData.themes = payload.result.themes;
        updateData.genres = payload.result.genres;
        updateData.targetAudience = payload.result.targetAudience;
        updateData.tone = payload.result.tone;
        updateData.style = payload.result.style;
        updateData.structure = payload.result.structure;
        updateData.pacing = payload.result.pacing;
        updateData.dialogue = payload.result.dialogue;
        updateData.action = payload.result.action;
        updateData.description = payload.result.description;
        updateData.environmentalInfluence =
          payload.result.environmentalInfluence;
        updateData.conclusion = payload.result.conclusion;
        updateData.relationship = payload.result.relationship;
        updateData.subText = payload.result.subText;
        updateData.coreThought = payload.result.coreThought;
        updateData.aiConfidenceScore = payload.result.confidenceScore;
      }

      await this.analysisRepository.updateAnalysis(
        analysisRecord.id,
        updateData,
      );

      // Update script status based on analysis result
      let scriptIdToCheck = analysisRecord.scriptId;

      // If scriptId is not in the analysis record, try to find script by taskId
      if (!scriptIdToCheck) {
        const scriptByTaskId = await this.scriptRepository.findOne({
          where: { taskId: payload.taskId },
          withDeleted: false,
        });
        if (scriptByTaskId) {
          scriptIdToCheck = scriptByTaskId.id;
          // Update the analysis record with the scriptId
          await this.analysisRepository.updateAnalysis(analysisRecord.id, {
            scriptId: scriptIdToCheck,
          });
        }
      }

      if (scriptIdToCheck) {
        const script = await this.scriptRepository.findOne({
          where: { id: scriptIdToCheck },
          withDeleted: false,
        });

        if (script) {
          const parserMetadata = {
            ...(script.parserMetadata || {}),
          } as Record<string, any>;

          if (payload.status === 'success') {
            script.status = ScriptStatus.ANALYZED;
            script.analysisId = analysisRecord.id;
            parserMetadata.analysisLifecycle = {
              ...(parserMetadata.analysisLifecycle || {}),
              ...(payload.resultMetadata?.analysisLifecycle || {}),
              lifecycleState:
                payload.resultMetadata?.analysisLifecycle?.lifecycleState ||
                'completed',
              currentStage: 'completed',
              finalStatus: 'ANALYZED',
              updatedAt: new Date().toISOString(),
            };
            script.parserMetadata = parserMetadata;
            await this.scriptRepository.save(script);

            if (script.projectId) {
              await this.ensureProjectIsActive(script.projectId);
            }

            this.emitScriptEmbed(
              script.id,
              payload.userId,
              script.contentHash ?? script.parserMetadata?.contentHash ?? null,
            );
          } else if (payload.status === 'failed') {
            script.status = ScriptStatus.FAILED;
            if (payload.resultMetadata?.degradedInputClassification) {
              parserMetadata.degradedInputClassification = {
                ...(parserMetadata.degradedInputClassification || {}),
                ...payload.resultMetadata.degradedInputClassification,
              };
            }
            parserMetadata.analysisLifecycle = {
              ...(parserMetadata.analysisLifecycle || {}),
              ...(payload.resultMetadata?.analysisLifecycle || {}),
              lifecycleState: 'failed',
              currentStage: 'failed',
              finalStatus: 'FAILED',
              degraded: false,
              attentionRequired: true,
              failureStage:
                payload.resultMetadata?.analysisLifecycle?.failureStage ||
                'semantic_analysis',
              failureCode:
                payload.errorCode ||
                payload.resultMetadata?.analysisLifecycle?.failureCode ||
                null,
              failureMessage:
                payload.error ||
                payload.resultMetadata?.analysisLifecycle?.failureMessage ||
                null,
              updatedAt: new Date().toISOString(),
            };
            script.parserMetadata = parserMetadata;
            await this.scriptRepository.save(script);

            if (script.projectId) {
              await this.ensureProjectIsActive(script.projectId);
            }
          }
        }
      }

      this.logger.log(
        `Analysis result stored successfully for task ${payload.taskId}`,
      );

      const channel = context.getChannelRef();
      const originalMessage = context.getMessage();
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        `Failed to store analysis result: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private emitScriptEmbed(
    scriptId: string,
    userId: string,
    contentHash: string | null,
  ): void {
    try {
      this.aiClient.emit(SCRIPT_QA_EVENTS.SCRIPT_EMBED, {
        scriptId,
        userId,
        contentHash,
      });
      this.logger.log(`Emitted script.embed for script ${scriptId}`);
    } catch (error) {
      this.logger.error(
        `Failed to emit script.embed for ${scriptId}: ${error.message}`,
      );
    }
  }

  /**
   * Keep project lifecycle independent from script analysis outcomes.
   * Projects become ACTIVE once scripts are attached; old pending projects are
   * upgraded the first time analysis results land.
   */
  private async ensureProjectIsActive(projectId: string): Promise<void> {
    try {
      const project = await this.projectRepository.findOne({
        where: { id: projectId },
        withDeleted: false,
      });

      if (!project || project.status === ProjectStatus.ACTIVE) {
        return;
      }

      await this.projectRepository.update(projectId, {
        status: ProjectStatus.ACTIVE,
      });

      this.logger.log(`Project ${projectId} marked ACTIVE`);
    } catch (error) {
      this.logger.error(
        `Error ensuring active project state for ${projectId}: ${error.message}`,
        error.stack,
      );
    }
  }
}
