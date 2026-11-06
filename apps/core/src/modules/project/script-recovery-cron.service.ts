import {
  AnalysisOutboxJob,
  AnalysisOutboxJobRepository,
  AnalysisOutboxStatus,
  ScriptStatus,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';

@Injectable()
export class ScriptRecoveryCronService {
  private readonly logger = new Logger(ScriptRecoveryCronService.name);

  /** Scripts stuck longer than this are considered zombies */
  private static readonly STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
  /** Max recovery attempts before marking as permanently FAILED */
  private static readonly MAX_ATTEMPTS = 5;

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxRepo: AnalysisOutboxJobRepository,
    @InjectRepository(AnalysisOutboxJob)
    private readonly outboxOrmRepo: Repository<AnalysisOutboxJob>,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async recoverZombieScripts(): Promise<void> {
    const staleBefore = new Date(
      Date.now() - ScriptRecoveryCronService.STALE_THRESHOLD_MS,
    );

    // Find scripts stuck in PROCESSING for > 15 minutes
    const stuckScripts = await this.dataSource.query(
      `SELECT id, "taskId", "projectId"
       FROM core_schema.scripts
       WHERE status = $1
         AND "updatedAt" < $2
         AND "deletedAt" IS NULL
       LIMIT 50`,
      [ScriptStatus.PROCESSING, staleBefore],
    );

    if (stuckScripts.length === 0) {
      return;
    }

    this.logger.warn(
      `Found ${stuckScripts.length} zombie script(s) stuck in PROCESSING`,
    );

    for (const script of stuckScripts) {
      await this.recoverScript(script);
    }
  }

  private async recoverScript(script: {
    id: string;
    taskId: string | null;
    projectId: string | null;
  }): Promise<void> {
    try {
      // Find existing outbox job for this script
      const existingJob = await this.outboxOrmRepo.findOne({
        where: { scriptId: script.id, deletedAt: undefined },
        order: { createdAt: 'DESC' },
      });

      if (existingJob) {
        await this.handleExistingJob(existingJob, script);
      } else {
        await this.handleMissingJob(script);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Failed to recover zombie script ${script.id}: ${message}`,
      );
    }
  }

  private async handleExistingJob(
    job: AnalysisOutboxJob,
    script: { id: string; taskId: string | null },
  ): Promise<void> {
    if (job.attempts >= ScriptRecoveryCronService.MAX_ATTEMPTS) {
      // Exhausted retries — mark script as permanently FAILED
      await this.dataSource.query(
        `UPDATE core_schema.scripts SET status = $1 WHERE id = $2`,
        [ScriptStatus.FAILED, script.id],
      );

      this.logger.error({
        msg: 'Script marked FAILED after max recovery attempts',
        scriptId: script.id,
        taskId: script.taskId,
        attempts: job.attempts,
      });
      return;
    }

    // Reset outbox job to PENDING so the dispatcher re-sends it
    await this.outboxOrmRepo.update(job.id, {
      status: AnalysisOutboxStatus.PENDING,
      nextAttemptAt: new Date(),
      lastError: `Recovered from zombie state (attempt ${job.attempts + 1})`,
    });

    this.logger.warn({
      msg: 'Reset zombie outbox job to PENDING for re-dispatch',
      scriptId: script.id,
      taskId: script.taskId,
      jobId: job.id,
      attempt: job.attempts + 1,
    });
  }

  private async handleMissingJob(script: {
    id: string;
    taskId: string | null;
    projectId: string | null;
  }): Promise<void> {
    if (!script.taskId || !script.projectId) {
      // Can't create an outbox job without these — mark as FAILED
      await this.dataSource.query(
        `UPDATE core_schema.scripts SET status = $1 WHERE id = $2`,
        [ScriptStatus.FAILED, script.id],
      );

      this.logger.error({
        msg: 'Script marked FAILED — missing taskId or projectId, cannot create outbox job',
        scriptId: script.id,
      });
      return;
    }

    // Fetch the script's fileUrl to build the outbox payload
    const [fullScript] = await this.dataSource.query(
      `SELECT "fileUrl", "sourceMediaId", "title"
       FROM core_schema.scripts
       WHERE id = $1`,
      [script.id],
    );

    if (!fullScript?.fileUrl) {
      await this.dataSource.query(
        `UPDATE core_schema.scripts SET status = $1 WHERE id = $2`,
        [ScriptStatus.FAILED, script.id],
      );

      this.logger.error({
        msg: 'Script marked FAILED — no fileUrl found',
        scriptId: script.id,
      });
      return;
    }

    await this.outboxRepo.createJob({
      eventType: 'ai.script-analysis',
      projectId: script.projectId,
      scriptId: script.id,
      taskId: script.taskId,
      status: AnalysisOutboxStatus.PENDING,
      nextAttemptAt: new Date(),
      attempts: 1,
      lastError: 'Recovered from zombie state — outbox job was missing',
      payload: {
        taskId: script.taskId,
        projectId: script.projectId,
        scriptId: script.id,
        fileUrl: fullScript.fileUrl,
        mediaId: fullScript.sourceMediaId,
        title: fullScript.title,
      },
    });

    this.logger.warn({
      msg: 'Created new outbox job for zombie script (no prior job found)',
      scriptId: script.id,
      taskId: script.taskId,
    });
  }
}
