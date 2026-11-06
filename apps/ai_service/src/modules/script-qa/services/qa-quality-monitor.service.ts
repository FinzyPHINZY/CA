import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

@Injectable()
export class QaQualityMonitorService {
  private readonly logger = new Logger(QaQualityMonitorService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron('0 3 * * *')
  async runNightlyQualityCheck(): Promise<void> {
    this.logger.log('Starting nightly Q&A quality check');

    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().slice(0, 10);

      const totalRows = await this.dataSource.query(
        `SELECT COUNT(*) AS count
         FROM ai_schema.qa_messages
         WHERE role = 'assistant'
           AND error IS NULL
           AND "createdAt" >= $1::date
           AND "createdAt" < ($1::date + INTERVAL '1 day')`,
        [dateStr],
      );

      const total = parseInt(totalRows[0]?.count ?? '0', 10);
      if (total === 0) {
        this.logger.log('No Q&A answers from yesterday, skipping quality check');
        return;
      }

      const sampleSize = Math.max(1, Math.ceil(total * 0.01));

      const sample = await this.dataSource.query(
        `SELECT id, content, citations, "queryClass", model
         FROM ai_schema.qa_messages
         WHERE role = 'assistant'
           AND error IS NULL
           AND "createdAt" >= $1::date
           AND "createdAt" < ($1::date + INTERVAL '1 day')
         ORDER BY random()
         LIMIT $2`,
        [dateStr, sampleSize],
      );

      const feedbackStats = await this.dataSource.query(
        `SELECT
           COUNT(*) FILTER (WHERE "userFeedback" = 1) AS thumbs_up,
           COUNT(*) FILTER (WHERE "userFeedback" = -1) AS thumbs_down,
           COUNT(*) FILTER (WHERE "userFeedback" IS NOT NULL) AS total_feedback
         FROM ai_schema.qa_messages
         WHERE role = 'assistant'
           AND "createdAt" >= $1::date
           AND "createdAt" < ($1::date + INTERVAL '1 day')`,
        [dateStr],
      );

      const stats = feedbackStats[0] ?? {};
      const thumbsUp = parseInt(stats.thumbs_up ?? '0', 10);
      const thumbsDown = parseInt(stats.thumbs_down ?? '0', 10);
      const totalFeedback = parseInt(stats.total_feedback ?? '0', 10);

      const satisfactionRate = totalFeedback > 0
        ? thumbsUp / totalFeedback
        : null;

      const hasCitations = sample.filter(
        (m: any) => m.citations && JSON.parse(JSON.stringify(m.citations)).length > 0,
      ).length;
      const citationRate = sample.length ? hasCitations / sample.length : 0;

      this.logger.log({
        msg: 'Q&A quality check complete',
        date: dateStr,
        totalAnswers: total,
        sampleSize: sample.length,
        citationRate: (citationRate * 100).toFixed(1) + '%',
        thumbsUp,
        thumbsDown,
        totalFeedback,
        satisfactionRate: satisfactionRate !== null
          ? (satisfactionRate * 100).toFixed(1) + '%'
          : 'N/A',
      });

      if (satisfactionRate !== null && satisfactionRate < 0.5 && totalFeedback >= 10) {
        this.logger.warn(
          `Q&A satisfaction rate dropped below 50%: ${(satisfactionRate * 100).toFixed(1)}% (${thumbsDown} thumbs down / ${totalFeedback} total feedback)`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Nightly quality check failed: ${error.message}`,
        error.stack,
      );
    }
  }
}
