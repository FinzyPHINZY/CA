/** biome-ignore-all lint/style/useImportType: <> */

import { FeedbackRequest, NOTIFICATIONS_SERVICE } from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';

// Send a reminder if feedback was requested 23–25 hours ago and not yet submitted.
const REMINDER_WINDOW_MIN_HOURS = 23;
const REMINDER_WINDOW_MAX_HOURS = 25;

@Injectable()
export class FeedbackReminderCronService {
  private readonly logger = new Logger(FeedbackReminderCronService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  @Cron('0 * * * *') // every hour on the hour
  async sendPendingFeedbackReminders(): Promise<void> {
    const repo = this.dataSource.getRepository(FeedbackRequest);
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - REMINDER_WINDOW_MAX_HOURS * 60 * 60 * 1000,
    );
    const windowEnd = new Date(
      now.getTime() - REMINDER_WINDOW_MIN_HOURS * 60 * 60 * 1000,
    );

    // fetch requests where either party still needs to submit and is in the 24h reminder window
    const pending = await repo
      .createQueryBuilder('fr')
      .where(
        '(fr.actorFeedbackSubmittedAt IS NULL AND fr.actorFeedbackRequestedAt IS NOT NULL AND fr.actorFeedbackRequestedAt BETWEEN :windowStart AND :windowEnd)',
        { windowStart, windowEnd },
      )
      .orWhere(
        '(fr.readerFeedbackSubmittedAt IS NULL AND fr.readerFeedbackRequestedAt IS NOT NULL AND fr.readerFeedbackRequestedAt BETWEEN :windowStart AND :windowEnd)',
        { windowStart, windowEnd },
      )
      .getMany();

    let actorReminders = 0;
    let readerReminders = 0;

    for (const req of pending) {
      const actorDue =
        req.actorFeedbackSubmittedAt === null &&
        req.actorFeedbackRequestedAt !== null &&
        req.actorFeedbackRequestedAt >= windowStart &&
        req.actorFeedbackRequestedAt <= windowEnd;

      const readerDue =
        req.readerFeedbackSubmittedAt === null &&
        req.readerFeedbackRequestedAt !== null &&
        req.readerFeedbackRequestedAt >= windowStart &&
        req.readerFeedbackRequestedAt <= windowEnd;

      if (actorDue) {
        this.notificationsClient.emit('feedback.reminder', {
          role: 'actor',
          recipientUserId: req.actorUserId,
          bookingId: req.bookingId,
        });
        actorReminders++;
      }

      if (readerDue) {
        this.notificationsClient.emit('feedback.reminder', {
          role: 'reader',
          recipientUserId: req.readerUserId,
          bookingId: req.bookingId,
        });
        readerReminders++;
      }
    }

    if (actorReminders + readerReminders > 0) {
      this.logger.log(
        `Sent ${actorReminders} actor + ${readerReminders} reader feedback reminders`,
      );
    }
  }
}
