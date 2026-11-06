import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  SCRIPT_ANALYSIS_QUEUE,
  SCRIPT_ANALYSIS_HEAVY_QUEUE,
  HEAVY_FILE_SIZE_THRESHOLD,
  ScriptAnalysisJobData,
  planToPriority,
} from '@app/common/bull';
import { SubscriptionPlan } from '@app/common';

@Injectable()
export class ScriptAnalysisProducerService {
  private readonly logger = new Logger(ScriptAnalysisProducerService.name);

  constructor(
    @InjectQueue(SCRIPT_ANALYSIS_QUEUE)
    private readonly analysisQueue: Queue<ScriptAnalysisJobData>,
    @InjectQueue(SCRIPT_ANALYSIS_HEAVY_QUEUE)
    private readonly heavyQueue: Queue<ScriptAnalysisJobData>,
  ) {}

  /**
   * Enqueue a script analysis job into the appropriate BullMQ queue.
   *
   * Routing rules:
   *  - fileSize ≥ 5 MB → heavy queue (dedicated workers, longer timeout)
   *  - fileSize <  5 MB → standard queue
   *
   * Priority is derived from the user's subscription plan.
   */
  async enqueue(data: ScriptAnalysisJobData): Promise<string> {
    const priority = planToPriority(data.plan);
    const isHeavy = data.fileSize >= HEAVY_FILE_SIZE_THRESHOLD;
    const queue = isHeavy ? this.heavyQueue : this.analysisQueue;
    const queueLabel = isHeavy ? 'heavy' : 'standard';

    const job = await queue.add('analyze', data, {
      jobId: data.taskId, // deduplication — same taskId won't enqueue twice
      priority,
    });

    this.logger.log({
      msg: 'script_analysis_job_enqueued',
      jobId: job.id,
      taskId: data.taskId,
      scriptId: data.scriptId,
      projectId: data.projectId,
      queue: queueLabel,
      priority,
      plan: data.plan,
      fileSize: data.fileSize,
    });

    return job.id!;
  }

  /**
   * Enqueue with a default FREE plan when subscription lookup is unavailable.
   */
  async enqueueWithDefaults(
    params: Omit<ScriptAnalysisJobData, 'plan' | 'fileSize'> & {
      plan?: SubscriptionPlan;
      fileSize?: number;
    },
  ): Promise<string> {
    return this.enqueue({
      ...params,
      plan: params.plan ?? SubscriptionPlan.FREE,
      fileSize: params.fileSize ?? 0,
    });
  }
}
