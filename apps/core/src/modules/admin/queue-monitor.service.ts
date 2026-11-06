import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

export interface QueueStats {
  name: string;
  messages: number;
  consumers: number;
  publishRate: number;
  deliverRate: number;
}

@Injectable()
export class QueueMonitorService {
  private readonly logger = new Logger(QueueMonitorService.name);

  private readonly rabbitmqManagementUrl: string;
  private readonly warnThreshold: number;
  private readonly criticalThreshold: number;
  private readonly minConsumers: number;

  private readonly monitoredQueues = [
    'script_parser.queue',
    'script_parser.results.queue',
    'ai_service.queue',
    'script_parser.dead',
  ];

  constructor(private readonly configService: ConfigService) {
    this.rabbitmqManagementUrl = this.configService.get<string>(
      'RABBITMQ_MANAGEMENT_URL',
      'http://rabbitmq:15672',
    );
    this.warnThreshold = this.configService.get<number>(
      'QUEUE_DEPTH_WARN_THRESHOLD',
      20,
    );
    this.criticalThreshold = this.configService.get<number>(
      'QUEUE_DEPTH_CRITICAL_THRESHOLD',
      50,
    );
    this.minConsumers = this.configService.get<number>(
      'QUEUE_CONSUMERS_MIN',
      1,
    );
  }

  @Cron('*/60 * * * * *') // every 60 seconds
  async checkQueueHealth(): Promise<void> {
    const results: QueueStats[] = [];

    for (const queueName of this.monitoredQueues) {
      try {
        const stats = await this.fetchQueueStats(queueName);
        if (stats) {
          results.push(stats);
          this.evaluateThresholds(stats);
        }
      } catch (error) {
        this.logger.warn(
          `Queue health check skipped for ${queueName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (results.length > 0) {
      this.logger.log({
        msg: 'queue_health_check',
        queues: results.map((q) => ({
          name: q.name,
          depth: q.messages,
          consumers: q.consumers,
        })),
      });
    }
  }

  async getQueueHealthSummary(): Promise<QueueStats[]> {
    const results: QueueStats[] = [];
    for (const queueName of this.monitoredQueues) {
      try {
        const stats = await this.fetchQueueStats(queueName);
        if (stats) results.push(stats);
      } catch (error) {
        this.logger.warn(
          `Unable to fetch queue summary for ${queueName}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return results;
  }

  private async fetchQueueStats(queueName: string): Promise<QueueStats | null> {
    const vhost = encodeURIComponent('/');
    const url = `${this.rabbitmqManagementUrl}/api/queues/${vhost}/${encodeURIComponent(queueName)}`;
    const username = this.configService.get<string>(
      'RABBITMQ_MANAGEMENT_USER',
      'guest',
    );
    const password = this.configService.get<string>(
      'RABBITMQ_MANAGEMENT_PASSWORD',
      'guest',
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      name: queueName,
      messages: data.messages ?? 0,
      consumers: data.consumers ?? 0,
      publishRate: data.message_stats?.publish_details?.rate ?? 0,
      deliverRate: data.message_stats?.deliver_get_details?.rate ?? 0,
    };
  }

  private evaluateThresholds(stats: QueueStats): void {
    // Dead queue: any message is critical
    if (stats.name.includes('.dead') && stats.messages > 0) {
      this.logger.error({
        msg: 'dead_queue_has_messages',
        queue: stats.name,
        depth: stats.messages,
        action: 'Investigate immediately — these are permanently failed jobs',
      });
      return;
    }

    if (stats.messages >= this.criticalThreshold) {
      this.logger.error({
        msg: 'queue_depth_critical',
        queue: stats.name,
        depth: stats.messages,
        threshold: this.criticalThreshold,
      });
    } else if (stats.messages >= this.warnThreshold) {
      this.logger.warn({
        msg: 'queue_depth_warning',
        queue: stats.name,
        depth: stats.messages,
        threshold: this.warnThreshold,
      });
    }

    // Consumer check (skip dead/delay queues — they shouldn't have consumers)
    if (
      !stats.name.includes('.dead') &&
      !stats.name.includes('.delay') &&
      stats.consumers < this.minConsumers
    ) {
      this.logger.error({
        msg: 'queue_no_consumers',
        queue: stats.name,
        consumers: stats.consumers,
        expected: this.minConsumers,
      });
    }
  }
}
