/** biome-ignore-all lint/style/useImportType: <> */

import { NOTIFICATIONS_SERVICE } from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

export interface BookingNotificationPayload {
  type:
    | 'booking.confirmed'
    | 'booking.cancelled'
    | 'booking.completed'
    | 'booking.no_show'
    | 'booking.reminder';
  bookingId: string;
  actorUserId: string;
  readerUserId: string;
  sessionStartUtc: string;
  sessionEndUtc: string;
  sessionDurationMinutes: number;
  priceCents: number;
  currency: string;
  cancellationReason?: string;
  cancelledBy?: string;
  reminderType?: '24h' | '1h' | '15min';
  /** ICS file content to attach to confirmation emails. Present only for booking.confirmed events. */
  actorIcsContent?: string;
  readerIcsContent?: string;
}

@Injectable()
export class BookingNotificationService {
  private readonly logger = new Logger(BookingNotificationService.name);

  constructor(
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  // emit a booking status change event to the notifications queue.
  async emitBookingStatusChange(
    payload: BookingNotificationPayload,
  ): Promise<void> {
    try {
      this.notificationsClient.emit('booking.status_changed', payload);
      this.logger.log(
        `Emitted ${payload.type} notification for booking ${payload.bookingId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to emit booking notification: ${error.message}`,
      );
    }
  }

  // schedule booking reminders by emitting events with delay metadata. notifications service handles the actual scheduling.
  async scheduleReminders(
    bookingId: string,
    actorUserId: string,
    readerUserId: string,
    sessionStartUtc: Date,
    sessionEndUtc: Date,
    sessionDurationMinutes: number,
    priceCents: number,
    currency: string,
  ): Promise<void> {
    const basePayload = {
      bookingId,
      actorUserId,
      readerUserId,
      sessionStartUtc: sessionStartUtc.toISOString(),
      sessionEndUtc: sessionEndUtc.toISOString(),
      sessionDurationMinutes,
      priceCents,
      currency,
    };

    const now = Date.now();
    const sessionStart = sessionStartUtc.getTime();

    // 24h reminder
    const twentyFourHBefore = sessionStart - 24 * 60 * 60 * 1000;
    if (twentyFourHBefore > now) {
      this.notificationsClient.emit('booking.reminder.schedule', {
        ...basePayload,
        type: 'booking.reminder' as const,
        reminderType: '24h',
        scheduledAt: new Date(twentyFourHBefore).toISOString(),
      });
    }

    // 1h reminder
    const oneHBefore = sessionStart - 60 * 60 * 1000;
    if (oneHBefore > now) {
      this.notificationsClient.emit('booking.reminder.schedule', {
        ...basePayload,
        type: 'booking.reminder' as const,
        reminderType: '1h',
        scheduledAt: new Date(oneHBefore).toISOString(),
      });
    }

    // 15min reminder
    const fifteenMinBefore = sessionStart - 15 * 60 * 1000;
    if (fifteenMinBefore > now) {
      this.notificationsClient.emit('booking.reminder.schedule', {
        ...basePayload,
        type: 'booking.reminder' as const,
        reminderType: '15min',
        scheduledAt: new Date(fifteenMinBefore).toISOString(),
      });
    }

    this.logger.log(`Scheduled reminders for booking ${bookingId}`);
  }
}
