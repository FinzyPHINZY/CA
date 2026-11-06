import {
  AI_SERVICE,
  AiScriptAnalysisDTO,
  AnalysisOutboxJob,
  AnalysisOutboxJobRepository,
  ScriptRepository,
  ScriptStatus,
} from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Cron, CronExpression } from '@nestjs/schedule';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AnalysisOutboxDispatcherService {
  private readonly logger = new Logger(AnalysisOutboxDispatcherService.name);

  private static readonly BATCH_SIZE = 10;
  static readonly STALE_AFTER_MS = 5 * 60 * 1000;
  private static readonly MAX_BACKOFF_MS = 15 * 60 * 1000;

  constructor(
    private readonly analysisOutboxJobRepository: AnalysisOutboxJobRepository,
    private readonly scriptRepository: ScriptRepository,
    @Inject(AI_SERVICE) private readonly aiClient: ClientProxy,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async dispatchPendingJobs(): Promise<void> {
    const jobs = await this.analysisOutboxJobRepository.claimDispatchableJobs(
      AnalysisOutboxDispatcherService.BATCH_SIZE,
      AnalysisOutboxDispatcherService.STALE_AFTER_MS,
    );

    if (jobs.length === 0) {
      return;
    }

    for (const job of jobs) {
      await this.dispatchJob(job);
    }
  }

  private async dispatchJob(job: AnalysisOutboxJob): Promise<void> {
    try {
      await firstValueFrom(
        this.aiClient.emit(job.eventType, job.payload as AiScriptAnalysisDTO),
      );

      await this.scriptRepository.update(job.scriptId, {
        status: ScriptStatus.PROCESSING,
      });
      await this.analysisOutboxJobRepository.markDispatched(job.id);

      this.logger.log(
        `Dispatched analysis outbox job ${job.id} for script ${job.scriptId}`,
      );
    } catch (error) {
      const nextAttemptAt = new Date(
        Date.now() + this.calculateBackoffMs(job.attempts),
      );
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown dispatch error';

      await this.analysisOutboxJobRepository.markFailed(
        job.id,
        errorMessage,
        nextAttemptAt,
      );

      this.logger.error(
        `Failed to dispatch outbox job ${job.id}: ${errorMessage}`,
      );
    }
  }

  private calculateBackoffMs(attempts: number): number {
    const attemptCount = Math.max(attempts, 1);
    return Math.min(
      30_000 * 2 ** (attemptCount - 1),
      AnalysisOutboxDispatcherService.MAX_BACKOFF_MS,
    );
  }
}
