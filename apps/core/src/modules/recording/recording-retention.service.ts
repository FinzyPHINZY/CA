/** biome-ignore-all lint/style/useImportType: <> */

import {
  NOTIFICATIONS_SERVICE,
  RecordingRepository,
  SubscriptionPlan,
} from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionService } from '../subscription/subscription.service';

// recording retention policy by subscription tier:
// - FREE:       30 days
// - STARTER:    90 days
// - PREMIUM:    365 days
// - ALL_ACCESS: unlimited (no auto-deletion)
const RETENTION_DAYS: Record<SubscriptionPlan, number | null> = {
  [SubscriptionPlan.FREE]: 30,
  [SubscriptionPlan.STARTER]: 90,
  [SubscriptionPlan.PREMIUM]: 365,
  [SubscriptionPlan.ALL_ACCESS]: null, // unlimited
};

const NOTIFICATION_DAYS_BEFORE = 7;

@Injectable()
export class RecordingRetentionService {
  private readonly logger = new Logger(RecordingRetentionService.name);

  constructor(
    private readonly recordingRepository: RecordingRepository,
    private readonly subscriptionService: SubscriptionService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  // runs daily at 3:00 AM to soft-delete expired recordings
  // and flag recordings approaching their retention limit.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async enforceRetentionPolicy(): Promise<void> {
    this.logger.log('Starting recording retention policy enforcement...');

    try {
      // get all non-deleted recordings grouped by user
      const recordings = await this.recordingRepository.findAll({
        select: ['id', 'userId', 'createdAt'],
      });

      // group recordings by userId for efficient subscription lookups
      const recordingsByUser = new Map<string, typeof recordings>();
      for (const recording of recordings) {
        const existing = recordingsByUser.get(recording.userId) || [];
        existing.push(recording);
        recordingsByUser.set(recording.userId, existing);
      }

      let deletedCount = 0;
      let warningCount = 0;

      for (const [userId, userRecordings] of recordingsByUser) {
        const subscription =
          await this.subscriptionService.findByUserId(userId);

        const plan = subscription?.plan || SubscriptionPlan.FREE;
        const retentionDays = RETENTION_DAYS[plan];

        // ALL_ACCESS users have unlimited retention
        if (retentionDays === null) {
          continue;
        }

        const now = new Date();
        const expirationDate = new Date();
        expirationDate.setDate(now.getDate() - retentionDays);

        const warningDate = new Date();
        warningDate.setDate(
          now.getDate() - (retentionDays - NOTIFICATION_DAYS_BEFORE),
        );

        for (const recording of userRecordings) {
          const createdAt = new Date(recording.createdAt);

          if (createdAt < expirationDate) {
            // recording has exceeded retention period — soft delete
            await this.recordingRepository.softRemoveById(recording.id);
            deletedCount++;
            this.logger.log(
              `Retention: soft-deleted recording ${recording.id} (user: ${userId}, plan: ${plan}, age: ${Math.floor((now.getTime() - createdAt.getTime()) / 86400000)}d)`,
            );

            this.notificationsClient.emit('recording.retention_deleted', {
              recipientUserId: userId,
              recordingId: recording.id,
              plan,
              retentionDays,
            });
          } else if (createdAt < warningDate) {
            // recording is within the warning window
            const daysRemaining = Math.floor(
              (createdAt.getTime() - expirationDate.getTime()) / 86400000,
            );
            warningCount++;
            this.logger.debug(
              `Retention warning: recording ${recording.id} expires in ${daysRemaining}d (user: ${userId})`,
            );

            this.notificationsClient.emit('recording.retention_warning', {
              recipientUserId: userId,
              recordingId: recording.id,
              daysRemaining,
              plan,
              retentionDays,
            });
          }
        }
      }

      this.logger.log(
        `Retention policy complete: ${deletedCount} recordings deleted, ${warningCount} recordings in warning window`,
      );
    } catch (error) {
      this.logger.error('Failed to enforce retention policy', error);
    }
  }
}
