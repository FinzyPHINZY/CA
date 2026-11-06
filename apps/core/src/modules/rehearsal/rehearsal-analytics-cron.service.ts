import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RehearsalAnalyticsService } from './rehearsal-analytics.service';

// Hourly: compute/cache analytics for all rehearsals completed in the past hour, then recompute project-level progress for any affected projects.
// Nightly (03:00): catch-up pass — any completed rehearsal without analytics or with analytics older than 24 h gets recomputed.
@Injectable()
export class RehearsalAnalyticsCronService {
  private readonly logger = new Logger(RehearsalAnalyticsCronService.name);

  constructor(private readonly analyticsService: RehearsalAnalyticsService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async aggregateRecentRehearsals(): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000); // past 1 hour
    this.logger.debug(
      `[cron] aggregating rehearsal analytics since ${since.toISOString()}`,
    );
    try {
      await this.analyticsService.computeAnalyticsForRehearsalsSince(since);
      await this.analyticsService.computeProjectProgressForRehearsalsSince(
        since,
      );
    } catch (err) {
      this.logger.error(
        `[cron] hourly aggregation error: ${(err as Error).message}`,
      );
    }
  }

  @Cron('0 3 * * *')
  async nightlyCatchup(): Promise<void> {
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
    this.logger.debug('[cron] nightly rehearsal analytics catch-up');
    try {
      await this.analyticsService.recomputeStaleRehearsalAnalytics(
        STALE_THRESHOLD_MS,
      );
    } catch (err) {
      this.logger.error(
        `[cron] nightly catch-up error: ${(err as Error).message}`,
      );
    }

    // Transcript PII retention — strip raw speech from old event rows.
    try {
      await this.analyticsService.redactExpiredTranscripts();
    } catch (err) {
      this.logger.error(
        `[cron] transcript redaction error: ${(err as Error).message}`,
      );
    }
  }
}
