/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  AgoraSessionRepository,
  BookingRepository,
  BookingStatus,
  NOTIFICATIONS_SERVICE,
} from '@app/common';
import { AgoraSessionStatus } from '@app/common/enums/studio.enum';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClientProxy } from '@nestjs/microservices';
import { AgoraChannelService } from './agora-channel.service';
import { SessionService } from './session.service';
import { BookedRehearsalService } from '../rehearsal/booked-rehearsal.service';

// How far in advance to pre-create Agora channels (minutes before session start).
const PRE_CREATE_WINDOW_MINUTES = 15;

@Injectable()
export class BookingSessionBridgeService {
  private readonly logger = new Logger(BookingSessionBridgeService.name);

  constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly agoraSessionRepository: AgoraSessionRepository,
    private readonly agoraChannelService: AgoraChannelService,
    private readonly sessionService: SessionService,
    private readonly bookedRehearsalService: BookedRehearsalService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  // Every 5 minutes: find CONFIRMED bookings starting within the next 15 minutes
  // and pre-create their Agora channels so both participants can join instantly.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async bridgeUpcomingSessions(): Promise<void> {
    try {
      const upcoming = await this.bookingRepository.findConfirmedStartingSoon(
        PRE_CREATE_WINDOW_MINUTES,
      );

      if (upcoming.length === 0) return;

      this.logger.log(
        `Bridge: found ${upcoming.length} confirmed booking(s) starting within ${PRE_CREATE_WINDOW_MINUTES} min`,
      );

      for (const booking of upcoming) {
        try {
          const rehearsal =
            await this.bookedRehearsalService.ensureForBooking(booking);

          // Check if a channel already exists for this booking
          const existing = await this.agoraSessionRepository.findByBookingId(
            booking.id,
          );

          if (existing && existing.status !== AgoraSessionStatus.ENDED) {
            if (existing.rehearsalId !== rehearsal.id) {
              await this.agoraSessionRepository.updateById(existing.id, {
                rehearsalId: rehearsal.id,
              } as any);
            }
            // Channel already ready — just send a reminder notification if not yet sent
            this.logger.debug(
              `Channel already exists for booking ${booking.id}: ${existing.channelName}`,
            );
            continue;
          }

          // Pre-create the channel using the actor as the creator
          const session = await this.agoraChannelService.createChannel(
            booking.actorUserId,
            { bookingId: booking.id, rehearsalId: rehearsal.id },
          );

          this.logger.log(
            `Pre-created channel ${session.channelName} for booking ${booking.id}`,
          );

          // Notify both participants that their session channel is ready
          this.notificationsClient.emit('session.channel_ready', {
            bookingId: booking.id,
            actorUserId: booking.actorUserId,
            readerUserId: booking.readerUserId,
            channelName: session.channelName,
            sessionStartUtc: booking.sessionStartUtc.toISOString(),
            sessionEndUtc: booking.sessionEndUtc.toISOString(),
            sessionDurationMinutes: booking.sessionDurationMinutes,
          });
        } catch (error: any) {
          this.logger.error(
            `Failed to bridge session for booking ${booking.id}: ${error.message}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Bridge cron failed: ${error.message}`, error.stack);
    }
  }

  // Every minute: find IN_PROGRESS bookings whose session end + 10min grace has passed
  // and force-complete them to prevent orphaned sessions.
  @Cron(CronExpression.EVERY_MINUTE)
  async enforceSessionTimeouts(): Promise<void> {
    try {
      const overdue = await this.bookingRepository.findInProgressPastForceEnd();

      if (overdue.length === 0) return;

      this.logger.warn(
        `Timeout enforcer: found ${overdue.length} overdue session(s)`,
      );

      for (const booking of overdue) {
        try {
          // Use the actor's userId as the completer (system action)
          await this.sessionService.completeSession(
            booking.id,
            booking.actorUserId,
          );

          this.logger.warn(
            `Session auto-completed (timeout): booking=${booking.id}`,
          );

          // Emit a timeout event so both participants see a clear message
          this.notificationsClient.emit('session.timeout', {
            bookingId: booking.id,
            actorUserId: booking.actorUserId,
            readerUserId: booking.readerUserId,
            scheduledEndUtc: booking.sessionEndUtc.toISOString(),
            autoCompletedAt: new Date().toISOString(),
          });
        } catch (error: any) {
          this.logger.error(
            `Failed to auto-complete overdue session ${booking.id}: ${error.message}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Timeout enforcer cron failed: ${error.message}`,
        error.stack,
      );
    }
  }

  // Every minute: warn participants when their session is approaching end.
  // Fires at booked duration to give a heads-up.
  @Cron(CronExpression.EVERY_MINUTE)
  async warnApproachingSessionEnd(): Promise<void> {
    try {
      // Find IN_PROGRESS bookings where sessionEndUtc is 5 minutes from now (±1 min window)
      const now = new Date();
      const warningWindowStart = new Date(now.getTime() + 4 * 60 * 1000);
      const warningWindowEnd = new Date(now.getTime() + 6 * 60 * 1000);

      const bookings = await this.bookingRepository
        .createQueryBuilder('booking')
        .where('booking.status = :status', {
          status: BookingStatus.IN_PROGRESS,
        })
        .andWhere('booking.sessionEndUtc >= :windowStart', {
          windowStart: warningWindowStart,
        })
        .andWhere('booking.sessionEndUtc <= :windowEnd', {
          windowEnd: warningWindowEnd,
        })
        .andWhere('booking.deletedAt IS NULL')
        .getMany();

      for (const booking of bookings) {
        this.notificationsClient.emit('session.ending_soon', {
          bookingId: booking.id,
          actorUserId: booking.actorUserId,
          readerUserId: booking.readerUserId,
          sessionEndUtc: booking.sessionEndUtc.toISOString(),
          minutesRemaining: 5,
        });

        this.logger.debug(
          `Sent 5-min warning for session booking=${booking.id}`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Warning cron failed: ${error.message}`, error.stack);
    }
  }
}
