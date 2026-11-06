import * as crypto from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { ClientProxy } from '@nestjs/microservices';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { AiServiceService } from './ai_service.service';
import { ConfigService } from '@nestjs/config';
import { DebugExtractDto } from './dto/debug-extract.dto';
import {
  AiScriptAnalysisDTO,
  Media,
  NOTIFICATIONS_SERVICE,
  MediaService,
  ScriptRepository,
  ScriptStatus,
  SESSION_FILE_EVENTS,
  type SessionFileAnalysisRequestedEvent,
} from '@app/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { defaultIfEmpty, firstValueFrom } from 'rxjs';
import { ScriptAnalysisNotificationEnum } from '@app/common/enums';
import { ScriptParserResultMessage } from './contracts/script-parser.contract';
import { UnsupportedDegradedScriptError } from './modules/ai-orchestrator/errors/unsupported-degraded-script.error';
import { SessionFileAnalysisService } from './modules/session-file-analysis/session-file-analysis.service';

@ApiTags('AI')
@Controller()
export class AiServiceController {
  private readonly logger = new Logger(AiServiceController.name);

  /**
   * Defensive ack. The RMQ channel can be closed by the broker mid-handler when
   * an unrelated message on the same channel exceeds the 30-min ack timeout
   * (PRECONDITION_FAILED 406). Calling `channel.ack()` on a dead channel throws
   * `IllegalOperationError: Channel closed`, which then propagates out of the
   * handler. Swallow the ack failure: NestJS will reconnect and the broker will
   * redeliver the unacked message, which our idempotency check then skips.
   */
  private safeAck(channel: any, message: any): void {
    try {
      channel.ack(message);
    } catch (error: any) {
      this.logger.warn(
        `Failed to ack message (channel likely closed): ${error.message}`,
      );
    }
  }

  constructor(
    private readonly aiServiceService: AiServiceService,
    private readonly configService: ConfigService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
    @Inject('SCRIPT_PARSER_SERVICE')
    private readonly scriptParserClient: ClientProxy,
    @Inject('CORE_SERVICE')
    private readonly coreClient: ClientProxy,
    private readonly mediaService: MediaService,
    private readonly scriptRepository: ScriptRepository,
    private readonly sessionFileAnalysisService: SessionFileAnalysisService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private static readonly IDEMPOTENCY_TTL = 86400; // 24 hours

  @Get()
  @ApiOperation({
    summary: 'Get AI service status',
    description:
      'Returns a simple hello message to verify the AI service is running',
  })
  @ApiOkResponse({
    description: 'Service is running',
    schema: { type: 'string', example: 'Hello from ACR AI Service!' },
  })
  getHello(): string {
    return this.aiServiceService.getHello();
  }

  @Post('debug/extract')
  @ApiOperation({
    summary: 'Debug: run external extractor directly',
    description:
      'Downloads a script via the AI service and runs the Adobe/Document AI extractor without going through the Python parser. Disabled unless ENABLE_DEBUG_EXTRACTOR=true.',
  })
  @ApiOkResponse({
    description: 'Extractor output',
    schema: {
      example: {
        rawTextPreview: 'INT. OFFICE - DAY\\nJOHN ...',
        rawTextLength: 12345,
        extractionAttempts: [],
        warnings: [],
        structuralFlags: {},
        sceneCount: 42,
      },
    },
  })
  async debugExtract(@Body() payload: DebugExtractDto) {
    const enabled = this.configService.get<boolean>(
      'ENABLE_DEBUG_EXTRACTOR',
      false,
    );
    if (!enabled) {
      throw new UnauthorizedException('Debug extractor is disabled');
    }
    return this.aiServiceService.debugExtractScript(
      payload.mediaUrl,
      payload.fileName || null,
    );
  }

  /**
   * Handle AI analysis requests from RabbitMQ queue.
   *
   * Active Phase 0 baseline path:
   * upload -> core outbox -> ai.script-analysis -> ai_service direct extraction + Gemini analysis.
   *
   * The older ai.analyze flow is legacy/inactive for project script analysis.
   * Phase 1 adds parser-first routing behind a feature flag.
   */
  @MessagePattern('ai.script-analysis')
  async analyzeScript(
    @Payload()
    data: AiScriptAnalysisDTO,
    @Ctx() context: RmqContext,
  ) {
    const routingSnapshot = this.getScriptAnalysisRoutingSnapshot(data.taskId);
    this.logger.log(
      `Received AI analysis request for task ${data.taskId}, project: ${data.projectId}`,
    );
    this.logger.log(
      `[AnalysisRouting] ${JSON.stringify({
        taskId: data.taskId,
        projectId: data.projectId,
        routePattern: 'ai.script-analysis',
        selectedPath: routingSnapshot.selectedPath,
        parserFirstEnabled: routingSnapshot.parserFirstEnabled,
        parserFirstRollout: routingSnapshot.parserFirstRollout,
        legacyAiAnalyzePathActive: false,
      })}`,
    );

    const channel = context.getChannelRef();
    const originalMessage = context.getMessage();
    const startTime = Date.now();

    try {
      const media = await this.mediaService.findById(data.mediaId);
      if (!media) {
        throw new Error(`Media ${data.mediaId} not found`);
      }

      // look up the Script entity created by core to get its ID
      const script = await this.scriptRepository.findByTaskId(data.taskId);
      if (!script) {
        throw new Error(`Script with taskId ${data.taskId} not found`);
      }

      const scriptName = media.fileName || 'Untitled Script';

      this.logger.log({
        msg: 'analysis_started',
        taskId: data.taskId,
        projectId: data.projectId,
        scriptId: script.id,
        fileName: scriptName,
      });

      const emitProgress = (
        progress: number,
        progressMessage: string,
        step?: string,
      ) => {
        this.notificationsClient
          .emit(ScriptAnalysisNotificationEnum.PROGRESS, {
            taskId: data.taskId,
            userId: data.userId,
            progressMessage,
            progress,
            step,
            scriptName,
          })
          .subscribe();
      };

      if (routingSnapshot.selectedPath === 'parser_first') {
        await this.scriptRepository.update(script.id, {
          status: ScriptStatus.PARSING,
          progress: 5,
        });
        emitProgress(5, 'Dispatching script to parser…', 'parser_dispatch');
        const parserJob = this.buildScriptParserJob(data, media, script.id);
        await firstValueFrom(
          this.scriptParserClient
            .emit('script_parser.parse', parserJob)
            .pipe(defaultIfEmpty(null)),
        );
        this.logger.log(
          `[AnalysisRouting] Parser job dispatched ${JSON.stringify({
            taskId: data.taskId,
            scriptId: script.id,
            projectId: data.projectId,
            mediaId: data.mediaId,
            queue: this.configService.get<string>(
              'SCRIPT_PARSER_QUEUE',
              'script_parser.queue',
            ),
          })}`,
        );
        this.safeAck(channel, originalMessage);
        return { status: 'queued', path: 'parser_first' };
      }

      await this.scriptRepository.update(script.id, {
        status: ScriptStatus.ANALYZING,
        progress: 5,
      });
      emitProgress(5, 'Downloading script media…', 'download');

      const analysisResult =
        await this.aiServiceService.analyzeScriptWithProgress(
          data,
          emitProgress,
        );

      await firstValueFrom(
        this.notificationsClient.emit(
          ScriptAnalysisNotificationEnum.COMPLETED,
          {
            taskId: data.taskId,
            userId: data.userId,
            scriptIndex: data.scriptIndex,
            scriptName,
            resultMetadata: {
              status: 'success',
              message: 'Analysis completed successfully',
              analysisLifecycle: analysisResult.analysisLifecycle || null,
            },
            result: analysisResult,
          },
        ),
      );

      await firstValueFrom(
        this.coreClient.emit('analysis.result.store', {
          taskId: data.taskId,
          userId: data.userId,
          status: 'success',
          result: analysisResult,
          scriptId: analysisResult.scriptId,
          resultMetadata: {
            analysisLifecycle: analysisResult.analysisLifecycle || null,
          },
        }),
      );

      this.logger.log({
        msg: 'analysis_completed',
        taskId: data.taskId,
        projectId: data.projectId,
        totalDurationMs: Date.now() - startTime,
        path: routingSnapshot.selectedPath,
      });

      this.safeAck(channel, originalMessage);
    } catch (error: any) {
      const failure = this.buildRuntimeFailure(error, {
        structuralPath: 'direct_extraction',
        semanticPath: 'gemini_raw_text_semantic',
        failureStage: 'semantic_analysis',
      });
      this.logger.error(
        `Failed to analyze script for task ${data.taskId}: ${error.message}`,
        error.stack,
      );

      try {
        await firstValueFrom(
          this.notificationsClient.emit(
            ScriptAnalysisNotificationEnum.COMPLETED,
            {
              taskId: data.taskId,
              userId: data.userId,
              scriptIndex: data.scriptIndex,
              resultMetadata: {
                status: 'failed',
                error: failure.message,
                errorCode: failure.errorCode,
                suggestions: failure.suggestions,
                analysisLifecycle: failure.analysisLifecycle,
                degradedInputClassification:
                  failure.degradedInputClassification || null,
              },
            },
          ),
        );
        await firstValueFrom(
          this.coreClient.emit('analysis.result.store', {
            taskId: data.taskId,
            userId: data.userId,
            status: 'failed',
            error: failure.message,
            errorCode: failure.errorCode,
            resultMetadata: {
              analysisLifecycle: failure.analysisLifecycle,
              degradedInputClassification:
                failure.degradedInputClassification || null,
            },
          }),
        );
      } catch (emitError: any) {
        this.logger.error(
          `Failed to emit dispatch failure: ${emitError.message}`,
        );
      }

      this.safeAck(channel, originalMessage);
      return { status: 'failed', error: error.message };
    }
  }

  // Core asks ai_service to analyze a file shared mid-call. We dispatch a
  // standard script_parser job tagged with an `sf_` task_id; the result
  // arrives on `script_parser.result` and gets branched off above.
  @MessagePattern(SESSION_FILE_EVENTS.ANALYSIS_REQUESTED)
  async handleSessionFileAnalysisRequested(
    @Payload() data: SessionFileAnalysisRequestedEvent,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMessage = context.getMessage();
    try {
      await this.sessionFileAnalysisService.dispatchAnalysis(data);
    } catch (err: any) {
      this.logger.error(
        `[SessionFileAnalysis] dispatch failed for sharedFile=${data.sharedFileId}: ${err.message}`,
        err.stack,
      );
      // Emit a failure result back to core so the FE doesn't hang waiting.
      await firstValueFrom(
        this.coreClient
          .emit(SESSION_FILE_EVENTS.ANALYSIS_RESULT, {
            pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
            rehearsalId: data.rehearsalId,
            sharedFileId: data.sharedFileId,
            status: 'failed' as const,
            error: err?.message ?? 'Failed to dispatch parser job',
            completedAt: new Date().toISOString(),
          })
          .pipe(defaultIfEmpty(null)),
      );
    } finally {
      this.safeAck(channel, originalMessage);
    }
  }

  @MessagePattern('script_parser.result')
  async handleScriptParserResult(
    @Payload() data: ScriptParserResultMessage,
    @Ctx() context: RmqContext,
  ) {
    const channel = context.getChannelRef();
    const originalMessage = context.getMessage();
    const semanticStartTime = Date.now();

    // Session-shared-file results: task_id carries the `sf_` prefix. Skip the
    // Script/Scene write path entirely — these are throwaway analyses owned
    // by SessionFilesService in core, not the project content pipeline.
    if (this.sessionFileAnalysisService.isSessionFileTask(data.task_id)) {
      try {
        await this.sessionFileAnalysisService.handleParseResult(data);
      } catch (err: any) {
        this.logger.error(
          `[SessionFileAnalysis] result handling failed for ${data.task_id}: ${err.message}`,
          err.stack,
        );
      } finally {
        this.safeAck(channel, originalMessage);
      }
      return { status: 'session_file_result' };
    }

    // Idempotency check — skip if this task_id was already analyzed
    if (data.task_id) {
      const wasSet = await this.redis.set(
        `analyzed:${data.task_id}`,
        '1',
        'EX',
        AiServiceController.IDEMPOTENCY_TTL,
        'NX',
      );
      if (!wasSet) {
        this.logger.log(`duplicate_job_skipped: task_id=${data.task_id}`);
        this.safeAck(channel, originalMessage);
        return { status: 'skipped', reason: 'duplicate' };
      }
    }

    const scriptName = data.file_name || 'Untitled Script';

    // Store content hash on script for duplicate detection
    if (data.content_hash && data.script_id) {
      await this.scriptRepository.update(data.script_id, {
        contentHash: data.content_hash,
      });
    }

    const emitProgress = (
      progress: number,
      progressMessage: string,
      step?: string,
    ) => {
      this.notificationsClient
        .emit(ScriptAnalysisNotificationEnum.PROGRESS, {
          taskId: data.task_id,
          userId: data.user_id,
          progressMessage,
          progress,
          step,
          scriptName,
        })
        .subscribe();
    };

    this.logger.log(
      `[AnalysisRouting] Parser result received ${JSON.stringify({
        taskId: data.task_id,
        scriptId: data.script_id,
        projectId: data.project_id || null,
        status: data.status,
        errorCode: data.error || null,
        parserPath: data.parser_path || null,
        parserChain: data.parser_chain || [],
        documentClass: (data.result as any)?.document_class || null,
      })}`,
    );

    try {
      // ── NEEDS_OCR: image-based PDF — delegate to legacy path which has
      // Document AI and Adobe Extract configured for OCR extraction ──────
      if (data.status === 'NEEDS_OCR') {
        this.logger.log(
          `[AnalysisRouting] Image PDF detected — falling back to legacy analysis path with Document AI/Adobe Extract ${JSON.stringify(
            {
              taskId: data.task_id,
              scriptId: data.script_id,
              projectId: data.project_id,
            },
          )}`,
        );

        if (data.script_id) {
          await this.scriptRepository.update(data.script_id, {
            status: ScriptStatus.ANALYZING,
            progress: 20,
          });
        }
        emitProgress(
          20,
          'Image-based PDF detected. Running OCR extraction…',
          'ocr_extraction',
        );

        const script = data.script_id
          ? await this.scriptRepository.findOne({
              where: { id: data.script_id },
            })
          : null;

        if (!script?.sourceMediaId) {
          throw new Error(
            `Could not find media for script ${data.script_id} to run OCR extraction`,
          );
        }

        const media = await this.mediaService.findById(script.sourceMediaId);
        if (!media) {
          throw new Error(
            `Media ${script.sourceMediaId} not found for OCR extraction`,
          );
        }

        const analysisResult =
          await this.aiServiceService.analyzeScriptWithProgress(
            {
              taskId: data.task_id,
              projectId: data.project_id!,
              userId: data.user_id,
              mediaId: media.id,
            },
            emitProgress,
          );

        await firstValueFrom(
          this.notificationsClient.emit(
            ScriptAnalysisNotificationEnum.COMPLETED,
            {
              taskId: data.task_id,
              userId: data.user_id,
              scriptIndex: data.script_index ?? undefined,
              scriptName,
              resultMetadata: {
                status: 'success',
                message:
                  'Analysis completed successfully (OCR extraction path)',
                analysisLifecycle: analysisResult.analysisLifecycle || null,
              },
              result: analysisResult,
            },
          ),
        );
        await firstValueFrom(
          this.coreClient.emit('analysis.result.store', {
            taskId: data.task_id,
            userId: data.user_id,
            status: 'success',
            result: analysisResult,
            scriptId: analysisResult.scriptId,
            resultMetadata: {
              analysisLifecycle: analysisResult.analysisLifecycle || null,
            },
          }),
        );

        this.logger.log({
          msg: 'ocr_fallback_analysis_completed',
          taskId: data.task_id,
          scriptId: data.script_id,
          semanticDurationMs: Date.now() - semanticStartTime,
          path: 'needs_ocr_legacy_fallback',
        });

        this.safeAck(channel, originalMessage);
        return { status: 'success', path: 'ocr_legacy_fallback' };
      }

      if (data.status !== 'SUCCESS' || !data.result) {
        const failure = this.buildParserFailure(data);
        await firstValueFrom(
          this.notificationsClient.emit(
            ScriptAnalysisNotificationEnum.COMPLETED,
            {
              taskId: data.task_id,
              userId: data.user_id,
              scriptIndex: data.script_index ?? undefined,
              scriptName,
              resultMetadata: {
                status: 'failed',
                error: failure.message,
                errorCode: failure.errorCode,
                suggestions: failure.suggestions,
                analysisLifecycle: {
                  lifecycleState: 'failed',
                  currentStage: 'failed',
                  degraded: false,
                  attentionRequired: true,
                  fallbackUsed: false,
                  failureStage:
                    data.status === 'VALIDATION_FAILED'
                      ? 'parser_validation'
                      : 'parser_processing',
                  failureCode: failure.errorCode,
                  failureMessage: failure.message,
                  structuralPath: 'python_script_parser',
                  semanticPath: 'parser_failed_before_semantic',
                  updatedAt: new Date().toISOString(),
                },
              },
            },
          ),
        );
        await firstValueFrom(
          this.coreClient.emit('analysis.result.store', {
            taskId: data.task_id,
            userId: data.user_id,
            scriptId: data.script_id,
            status: 'failed',
            error: failure.message,
            errorCode: failure.errorCode,
            resultMetadata: {
              analysisLifecycle: {
                lifecycleState: 'failed',
                currentStage: 'failed',
                degraded: false,
                attentionRequired: true,
                fallbackUsed: false,
                failureStage:
                  data.status === 'VALIDATION_FAILED'
                    ? 'parser_validation'
                    : 'parser_processing',
                failureCode: failure.errorCode,
                failureMessage: failure.message,
                structuralPath: 'python_script_parser',
                semanticPath: 'parser_failed_before_semantic',
                updatedAt: new Date().toISOString(),
              },
            },
          }),
        );
        this.safeAck(channel, originalMessage);
        return { status: 'failed', error: failure.message };
      }

      if (data.script_id) {
        await this.scriptRepository.update(data.script_id, {
          status: ScriptStatus.ANALYZING,
          progress: 35,
        });
      }
      emitProgress(
        35,
        'Parsed script structure. Running AI analysis…',
        'analysis',
      );
      const analysisResult =
        await this.aiServiceService.analyzeParsedScriptWithProgress(
          data,
          emitProgress,
        );

      await firstValueFrom(
        this.notificationsClient.emit(
          ScriptAnalysisNotificationEnum.COMPLETED,
          {
            taskId: data.task_id,
            userId: data.user_id,
            scriptIndex: data.script_index ?? undefined,
            scriptName,
            resultMetadata: {
              status: 'success',
              message: 'Analysis completed successfully',
              analysisLifecycle: analysisResult.analysisLifecycle || null,
            },
            result: analysisResult,
          },
        ),
      );
      await firstValueFrom(
        this.coreClient.emit('analysis.result.store', {
          taskId: data.task_id,
          userId: data.user_id,
          status: 'success',
          result: analysisResult,
          scriptId: analysisResult.scriptId,
          resultMetadata: {
            analysisLifecycle: analysisResult.analysisLifecycle || null,
          },
        }),
      );

      this.logger.log({
        msg: 'semantic_analysis_completed',
        taskId: data.task_id,
        scriptId: data.script_id,
        semanticDurationMs: Date.now() - semanticStartTime,
        path: 'parser_first',
      });

      this.safeAck(channel, originalMessage);
      return { status: 'success' };
    } catch (error: any) {
      const failure = this.buildRuntimeFailure(error, {
        structuralPath: 'python_script_parser',
        semanticPath: 'gemini_scene_semantic',
        failureStage: 'semantic_analysis',
      });
      this.logger.error(
        `Failed to handle parser result for task ${data.task_id}: ${error.message}`,
        error.stack,
      );
      try {
        await firstValueFrom(
          this.notificationsClient.emit(
            ScriptAnalysisNotificationEnum.COMPLETED,
            {
              taskId: data.task_id,
              userId: data.user_id,
              scriptIndex: data.script_index ?? undefined,
              scriptName,
              resultMetadata: {
                status: 'failed',
                error: failure.message,
                errorCode: failure.errorCode,
                suggestions: failure.suggestions,
                analysisLifecycle: failure.analysisLifecycle,
                degradedInputClassification:
                  failure.degradedInputClassification || null,
              },
            },
          ),
        );
        await firstValueFrom(
          this.coreClient.emit('analysis.result.store', {
            taskId: data.task_id,
            userId: data.user_id,
            scriptId: data.script_id,
            status: 'failed',
            error: failure.message,
            errorCode: failure.errorCode,
            resultMetadata: {
              analysisLifecycle: failure.analysisLifecycle,
              degradedInputClassification:
                failure.degradedInputClassification || null,
            },
          }),
        );
      } catch (emitError: any) {
        this.logger.error(
          `Failed to emit parser result failure for task ${data.task_id}: ${emitError.message}`,
        );
      }
      this.safeAck(channel, originalMessage);
      return { status: 'failed', error: error.message };
    }
  }

  private getScriptAnalysisRoutingSnapshot(taskId: string) {
    const parserFirstEnabled = this.configService.get<boolean>(
      'ENABLE_PARSER_FIRST_ANALYSIS',
      false,
    );
    const parserFirstRollout = this.configService.get<number>(
      'PARSER_FIRST_ANALYSIS_ROLLOUT',
      0,
    );
    const parserFirstSelected = this.shouldUseParserFirst(
      taskId,
      parserFirstEnabled,
      parserFirstRollout,
    );
    return {
      selectedPath: parserFirstSelected ? 'parser_first' : 'direct',
      parserFirstEnabled,
      parserFirstRollout,
    };
  }

  private shouldUseParserFirst(
    taskId: string,
    parserFirstEnabled: boolean,
    parserFirstRollout: number,
  ) {
    if (!parserFirstEnabled || parserFirstRollout <= 0) {
      return false;
    }
    if (parserFirstRollout >= 100) {
      return true;
    }

    const hash = crypto.createHash('sha256').update(taskId).digest();
    const bucket = hash[0] % 100;
    return bucket < parserFirstRollout;
  }

  private buildScriptParserJob(
    data: AiScriptAnalysisDTO,
    media: Media,
    scriptId: string,
  ) {
    return {
      task_id: data.taskId,
      media_url: media.url,
      file_name: media.fileName || 'Untitled Script',
      file_extension: this.getFileExtension(media.fileName, media.url),
      user_id: data.userId,
      project_id: data.projectId,
      script_id: scriptId,
      script_index: data.scriptIndex,
      media_id: data.mediaId,
    };
  }

  private getFileExtension(
    fileName?: string | null,
    mediaUrl?: string | null,
  ): string {
    const source = fileName || mediaUrl || '';
    const withoutQuery = source.split('?')[0];
    const ext = withoutQuery.split('.').pop()?.toLowerCase();
    return ext || 'pdf';
  }

  private buildParserFailure(data: ScriptParserResultMessage) {
    const errorCode = data.error || data.status;

    const messageMap: Record<string, string> = {
      NOT_A_SCREENPLAY:
        "We couldn't recognize this file as a screenplay. Screenplays need scene headings (INT./EXT.), character names, and dialogue formatting. Please check you uploaded the correct file, or try exporting from your screenwriting app as FDX or clean PDF.",
      STAGE_PLAY_DETECTED:
        'This looks like a stage play, which uses a different format than screenplays. CueActor currently supports screenplay format only.',
      LOW_CONFIDENCE:
        'We had trouble reading this script clearly. This can happen with heavily watermarked PDFs or unusual formatting. Try uploading a cleaner copy or the original FDX file.',
    };

    const message =
      data.message ||
      messageMap[errorCode] ||
      'Something went wrong while processing your script. Please try again. If it keeps failing, contact support with your file so we can investigate.';

    const suggestionsMap: Record<string, string[]> = {
      NOT_A_SCREENPLAY: [
        'Confirm the upload is a screenplay (with INT./EXT. scene headings, character names, and dialogue).',
        'Export from the original writing app as FDX or clean PDF.',
      ],
      STAGE_PLAY_DETECTED: [
        'CueActor supports screenplay format only at this time.',
        'If this is actually a screenplay, try exporting as FDX.',
      ],
      LOW_CONFIDENCE: [
        'Upload a cleaner copy with fewer watermarks.',
        'Use the original FDX if it is available.',
      ],
    };

    const suggestions = suggestionsMap[errorCode] || [
      'Retry analysis. If it fails again, contact support with your file.',
    ];

    return { errorCode, message, suggestions };
  }

  private buildRuntimeFailure(
    error: any,
    defaults: {
      structuralPath: string;
      semanticPath: string;
      failureStage: string;
    },
  ) {
    if (error instanceof UnsupportedDegradedScriptError) {
      return {
        errorCode: error.failureCode,
        message: error.failureMessage,
        suggestions: [
          'Upload a cleaner PDF.',
          'Use the original script export if it is available.',
        ],
        degradedInputClassification: error.degradedInputClassification || null,
        analysisLifecycle: {
          lifecycleState: 'failed',
          currentStage: 'failed',
          degraded: false,
          attentionRequired: true,
          fallbackUsed: false,
          failureStage: error.failureStage,
          failureCode: error.failureCode,
          failureMessage: error.failureMessage,
          structuralPath: error.structuralPath,
          semanticPath: error.semanticPath,
          extractionSource: error.extractionSource,
          updatedAt: new Date().toISOString(),
        },
      };
    }

    const message = error?.message || 'Unknown analysis failure';
    return {
      errorCode: null,
      message,
      suggestions: [],
      degradedInputClassification: null,
      analysisLifecycle: {
        lifecycleState: 'failed',
        currentStage: 'failed',
        degraded: false,
        attentionRequired: true,
        fallbackUsed: false,
        failureStage: defaults.failureStage,
        failureCode: null,
        failureMessage: message,
        structuralPath: defaults.structuralPath,
        semanticPath: defaults.semanticPath,
        updatedAt: new Date().toISOString(),
      },
    };
  }
}
