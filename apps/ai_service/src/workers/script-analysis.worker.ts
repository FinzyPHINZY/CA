import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker, Job } from 'bullmq';
import {
  SCRIPT_ANALYSIS_QUEUE,
  SCRIPT_ANALYSIS_HEAVY_QUEUE,
  ScriptAnalysisJobData,
} from '@app/common/bull';
import {
  AiScriptAnalysisDTO,
  NOTIFICATIONS_SERVICE,
  MediaService,
  ScriptRepository,
  ScriptStatus,
  withSpan,
} from '@app/common';
import { Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, defaultIfEmpty } from 'rxjs';
import { ScriptAnalysisNotificationEnum } from '@app/common/enums';
import { AiServiceService } from '../ai_service.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class ScriptAnalysisWorkerService implements OnModuleInit {
  private readonly logger = new Logger(ScriptAnalysisWorkerService.name);
  private workers: Worker[] = [];

  private static readonly IDEMPOTENCY_TTL = 86400; // 24 hours

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue(SCRIPT_ANALYSIS_QUEUE)
    private readonly analysisQueue: Queue<ScriptAnalysisJobData>,
    @InjectQueue(SCRIPT_ANALYSIS_HEAVY_QUEUE)
    private readonly heavyQueue: Queue<ScriptAnalysisJobData>,
    private readonly aiServiceService: AiServiceService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
    @Inject('SCRIPT_PARSER_SERVICE')
    private readonly scriptParserClient: ClientProxy,
    @Inject('CORE_SERVICE')
    private readonly coreClient: ClientProxy,
    private readonly mediaService: MediaService,
    private readonly scriptRepository: ScriptRepository,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
    const useBullMQ = this.configService.get<boolean>(
      'USE_BULLMQ_DISPATCH',
      false,
    );

    if (!useBullMQ) {
      this.logger.log(
        'BullMQ workers disabled (USE_BULLMQ_DISPATCH=false). Using RabbitMQ outbox path.',
      );
      return;
    }

    const standardConcurrency = this.configService.get<number>(
      'BULLMQ_STANDARD_CONCURRENCY',
      3,
    );
    const heavyConcurrency = this.configService.get<number>(
      'BULLMQ_HEAVY_CONCURRENCY',
      1,
    );

    const standardWorker = new Worker<ScriptAnalysisJobData>(
      SCRIPT_ANALYSIS_QUEUE,
      (job) => this.processJob(job),
      {
        connection: { url: redisUrl },
        concurrency: standardConcurrency,
        lockDuration: 300_000, // 5 min
      },
    );
    this.setupWorkerEvents(standardWorker, 'standard');
    this.workers.push(standardWorker);

    const heavyWorker = new Worker<ScriptAnalysisJobData>(
      SCRIPT_ANALYSIS_HEAVY_QUEUE,
      (job) => this.processJob(job),
      {
        connection: { url: redisUrl },
        concurrency: heavyConcurrency,
        lockDuration: 900_000, // 15 min for large files
      },
    );
    this.setupWorkerEvents(heavyWorker, 'heavy');
    this.workers.push(heavyWorker);

    this.logger.log(
      `BullMQ workers started — standard(concurrency=${standardConcurrency}), heavy(concurrency=${heavyConcurrency})`,
    );
  }

  private setupWorkerEvents(worker: Worker, label: string) {
    worker.on('completed', (job) => {
      this.logger.log({
        msg: 'bullmq_job_completed',
        queue: label,
        jobId: job.id,
        taskId: job.data.taskId,
      });
    });

    worker.on('failed', (job, error) => {
      this.logger.error({
        msg: 'bullmq_job_failed',
        queue: label,
        jobId: job?.id,
        taskId: job?.data?.taskId,
        error: error.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    worker.on('error', (error) => {
      this.logger.error({
        msg: 'bullmq_worker_error',
        queue: label,
        error: error.message,
      });
    });
  }

  /**
   * Process a script analysis job — mirrors the logic in ai_service.controller.ts
   * `analyzeScript()` handler but driven by BullMQ instead of RabbitMQ.
   *
   * The job completes once the analysis request is dispatched to the parser
   * (parser_first path) or when direct analysis finishes.
   */
  private async processJob(
    job: Job<ScriptAnalysisJobData>,
  ): Promise<{ status: string }> {
    return withSpan(
      'script.analysis.bullmq',
      {
        taskId: job.data.taskId,
        projectId: job.data.projectId,
        priority: job.opts.priority ?? 8,
        fileSize: job.data.fileSize,
      },
      () => this.processJobInner(job),
    );
  }

  private async processJobInner(
    job: Job<ScriptAnalysisJobData>,
  ): Promise<{ status: string }> {
    const data = job.data;
    const startTime = Date.now();

    this.logger.log({
      msg: 'bullmq_job_started',
      jobId: job.id,
      taskId: data.taskId,
      projectId: data.projectId,
      attempt: job.attemptsMade + 1,
      priority: job.opts.priority,
    });

    // Build the DTO that downstream methods expect
    const analysisDto: AiScriptAnalysisDTO = {
      projectId: data.projectId,
      userId: data.userId,
      mediaId: data.mediaId,
      taskId: data.taskId,
      scriptIndex: data.scriptIndex,
    };

    try {
      const media = await this.mediaService.findById(data.mediaId);
      if (!media) {
        throw new Error(`Media ${data.mediaId} not found`);
      }

      const script = await this.scriptRepository.findByTaskId(data.taskId);
      if (!script) {
        throw new Error(`Script with taskId ${data.taskId} not found`);
      }

      const scriptName = media.fileName || 'Untitled Script';

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
        // Also update BullMQ job progress for Bull Board visibility
        job.updateProgress(progress).catch(() => {});
      };

      // Determine routing: parser_first vs direct
      const parserFirstEnabled = this.configService.get<boolean>(
        'ENABLE_PARSER_FIRST_ANALYSIS',
        false,
      );
      const parserFirstRollout = this.configService.get<number>(
        'PARSER_FIRST_ANALYSIS_ROLLOUT',
        0,
      );
      const useParserFirst = this.shouldUseParserFirst(
        data.taskId,
        parserFirstEnabled,
        parserFirstRollout,
      );

      if (useParserFirst) {
        // Parser-first path: dispatch to Python parser and complete
        await this.scriptRepository.update(script.id, {
          status: ScriptStatus.PARSING,
          progress: 5,
        });
        emitProgress(5, 'Dispatching script to parser…', 'parser_dispatch');

        const parserJob = {
          task_id: data.taskId,
          media_url: media.url,
          file_name: media.fileName || 'Untitled Script',
          file_extension: this.getFileExtension(media.fileName, media.url),
          user_id: data.userId,
          project_id: data.projectId,
          script_id: script.id,
          script_index: data.scriptIndex,
          media_id: data.mediaId,
        };

        await firstValueFrom(
          this.scriptParserClient
            .emit('script_parser.parse', parserJob)
            .pipe(defaultIfEmpty(null)),
        );

        this.logger.log({
          msg: 'parser_job_dispatched_via_bullmq',
          taskId: data.taskId,
          scriptId: script.id,
          durationMs: Date.now() - startTime,
        });

        return { status: 'queued_parser' };
      }

      // Direct path: run full analysis in this worker
      await this.scriptRepository.update(script.id, {
        status: ScriptStatus.ANALYZING,
        progress: 5,
      });
      emitProgress(5, 'Downloading script media…', 'download');

      const analysisResult =
        await this.aiServiceService.analyzeScriptWithProgress(
          analysisDto,
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
        msg: 'bullmq_analysis_completed',
        taskId: data.taskId,
        projectId: data.projectId,
        totalDurationMs: Date.now() - startTime,
        path: 'direct',
      });

      return { status: 'success' };
    } catch (error: any) {
      this.logger.error({
        msg: 'bullmq_job_processing_error',
        taskId: data.taskId,
        error: error.message,
        attempt: job.attemptsMade + 1,
      });

      // On final attempt, emit failure notification
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 3)) {
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
                  error: error.message,
                  errorCode: null,
                  analysisLifecycle: {
                    lifecycleState: 'failed',
                    currentStage: 'failed',
                    degraded: false,
                    attentionRequired: true,
                    fallbackUsed: false,
                    failureStage: 'bullmq_worker',
                    failureMessage: error.message,
                    updatedAt: new Date().toISOString(),
                  },
                },
              },
            ),
          );
          await firstValueFrom(
            this.coreClient.emit('analysis.result.store', {
              taskId: data.taskId,
              userId: data.userId,
              scriptId: data.scriptId,
              status: 'failed',
              error: error.message,
            }),
          );
        } catch (emitError: any) {
          this.logger.error(
            `Failed to emit BullMQ failure notification: ${emitError.message}`,
          );
        }
      }

      throw error; // Let BullMQ handle the retry
    }
  }

  private shouldUseParserFirst(
    taskId: string,
    enabled: boolean,
    rollout: number,
  ): boolean {
    if (!enabled || rollout <= 0) return false;
    if (rollout >= 100) return true;
    const crypto = require('node:crypto');
    const hash = crypto.createHash('sha256').update(taskId).digest();
    return hash[0] % 100 < rollout;
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

  async onModuleDestroy() {
    for (const worker of this.workers) {
      await worker.close();
    }
    this.logger.log('BullMQ workers shut down');
  }
}
