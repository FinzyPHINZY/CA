import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NotificationsGateway } from './websocket.gateway';
import { ScriptAnalysisNotificationEnum } from '@app/common/enums';

interface QueueJob {
  id: string;
  type: ScriptAnalysisNotificationEnum;
  payload: any;
  createdAt: Date;
}

interface ProgressEventPayload {
  taskId: string;
  userId: string;
  progressMessage: string;
  progress?: number;
  step?: string;
}

interface TaskCompletedPayload {
  taskId: string;
  userId: string;
  scriptIndex?: number; // Index of script in project (0 for first, etc.)
  resultMetadata: {
    status: 'success' | 'failed';
    message?: string;
    error?: string;
  };
}

/**
 * In-memory queue service for notification events
 * Can be replaced with Redis/BullMQ for production
 */
@Injectable()
export class NotificationQueueService implements OnModuleInit {
  private readonly logger = new Logger(NotificationQueueService.name);
  private readonly queue: QueueJob[] = [];
  private isProcessing = false;

  constructor(private readonly notificationsGateway: NotificationsGateway) {}

  onModuleInit() {
    this.logger.log('NotificationQueueService initialized');
    this.startConsumer();
  }

  /**
   * Add a progress event to the queue
   */
  async addProgressEvent(payload: ProgressEventPayload): Promise<void> {
    const job: QueueJob = {
      id: `progress-${Date.now()}-${Math.random()}`,
      type: ScriptAnalysisNotificationEnum.PROGRESS,
      payload,
      createdAt: new Date(),
    };

    this.queue.push(job);
    this.logger.debug(`Progress event added to queue: ${payload.taskId}`);
    this.processQueue();
  }

  /**
   * Add a completion event to the queue
   * Prioritizes index 0 scripts to be processed first
   */
  async addCompletionEvent(payload: TaskCompletedPayload): Promise<void> {
    const job: QueueJob = {
      id: `completed-${Date.now()}-${Math.random()}`,
      type: ScriptAnalysisNotificationEnum.COMPLETED,
      payload,
      createdAt: new Date(),
    };

    // If this is index 0, add to front of queue; otherwise add to end
    if (payload.scriptIndex === 0) {
      // Find the first non-index-0 completion event and insert before it
      const firstNonZeroIndex = this.queue.findIndex(
        (j) =>
          j.type === ScriptAnalysisNotificationEnum.COMPLETED &&
          (j.payload as TaskCompletedPayload).scriptIndex !== 0,
      );
      if (firstNonZeroIndex >= 0) {
        this.queue.splice(firstNonZeroIndex, 0, job);
      } else {
        // No non-index-0 events, just add to front
        this.queue.unshift(job);
      }
      this.logger.debug(
        `Completion event for index 0 script added to queue (prioritized): ${payload.taskId}`,
      );
    } else {
      this.queue.push(job);
      this.logger.debug(
        `Completion event added to queue: ${payload.taskId} (index: ${payload.scriptIndex ?? 'unknown'})`,
      );
    }
    this.processQueue();
  }

  /**
   * Process jobs from the queue
   * Prioritizes index 0 completion events to be processed first
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      // Find the next job to process
      // Priority: index 0 completion events first, then others in order
      let jobIndex = -1;
      if (this.queue.length > 0) {
        // Look for index 0 completion events first
        jobIndex = this.queue.findIndex(
          (job) =>
            job.type === ScriptAnalysisNotificationEnum.COMPLETED &&
            (job.payload as TaskCompletedPayload).scriptIndex === 0,
        );

        // If no index 0 completion event found, process the first job
        if (jobIndex === -1) {
          jobIndex = 0;
        }
      }

      if (jobIndex === -1) break;

      const job = this.queue.splice(jobIndex, 1)[0];
      if (!job) break;

      try {
        await this.processJob(job);
      } catch (error) {
        this.logger.error(
          `Error processing job ${job.id}: ${error.message}`,
          error.stack,
        );
        // Optionally re-queue failed jobs
      }
    }

    this.isProcessing = false;
  }

  /**
   * Process a single job
   */
  private async processJob(job: QueueJob): Promise<void> {
    this.logger.debug(`Processing job: ${job.id} (${job.type})`);

    switch (job.type) {
      case ScriptAnalysisNotificationEnum.PROGRESS:
        this.notificationsGateway.emitProgressEvent(
          job.payload.userId,
          job.payload as ProgressEventPayload,
        );
        break;

      case ScriptAnalysisNotificationEnum.COMPLETED:
        this.notificationsGateway.emitTaskCompleted(
          job.payload.userId,
          job.payload as TaskCompletedPayload,
        );
        break;

      default:
        this.logger.warn(`Unknown job type: ${job.type}`);
    }
  }

  /**
   * Start the consumer loop
   */
  private startConsumer(): void {
    // Process queue every 100ms
    setInterval(() => {
      this.processQueue();
    }, 100);

    this.logger.log('Queue consumer started');
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): { pending: number; types: Record<string, number> } {
    const types: Record<string, number> = {};
    this.queue.forEach((job) => {
      types[job.type] = (types[job.type] || 0) + 1;
    });

    return {
      pending: this.queue.length,
      types,
    };
  }
}
