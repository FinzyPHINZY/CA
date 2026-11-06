/** biome-ignore-all lint/style/useImportType: <> */

import { Booking, FeedbackRequest, NOTIFICATIONS_SERVICE } from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';

@Injectable()
export class FeedbackNotificationService {
  private readonly logger = new Logger(FeedbackNotificationService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  /**
   * Called immediately after a booking completes (or moves to AWAITING_SETTLEMENT).
   * Creates a FeedbackRequest record and emits feedback.request events for both
   * the actor and the reader. Idempotent — safe to call multiple times for the
   * same booking (duplicate bookingId is ignored via unique constraint).
   */
  async requestFeedbackAfterCompletion(booking: Booking): Promise<void> {
    const repo = this.dataSource.getRepository(FeedbackRequest);

    // idempotency check — don't double-request
    const existing = await repo.findOne({
      where: { bookingId: booking.id },
    });
    if (existing) return;

    const now = new Date();
    const request = repo.create({
      bookingId: booking.id,
      actorUserId: booking.actorUserId,
      readerUserId: booking.readerUserId,
      actorFeedbackRequestedAt: now,
      readerFeedbackRequestedAt: now,
    });
    await repo.save(request);

    // emit for actor (reviews reader)
    this.notificationsClient.emit('feedback.request', {
      role: 'actor',
      recipientUserId: booking.actorUserId,
      bookingId: booking.id,
    });

    // emit for reader (reviews actor)
    this.notificationsClient.emit('feedback.request', {
      role: 'reader',
      recipientUserId: booking.readerUserId,
      bookingId: booking.id,
    });

    this.logger.log(`Feedback requests sent for booking ${booking.id}`);
  }

  /**
   * Marks a participant's feedback as submitted. Called from review services
   * after a review is successfully saved, so reminders are suppressed.
   */
  async markFeedbackSubmitted(
    bookingId: string,
    role: 'actor' | 'reader',
  ): Promise<void> {
    const repo = this.dataSource.getRepository(FeedbackRequest);
    const request = await repo.findOne({ where: { bookingId } });
    if (!request) return;

    if (role === 'actor') {
      request.actorFeedbackSubmittedAt = new Date();
    } else {
      request.readerFeedbackSubmittedAt = new Date();
    }
    await repo.save(request);
  }
}
