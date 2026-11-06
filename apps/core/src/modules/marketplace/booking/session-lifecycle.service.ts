/** biome-ignore-all lint/style/useImportType: <> */

import {
  Booking,
  BookingStatus,
  PaymentRecord,
  PaymentRecordStatus,
  ReaderProfile,
  TimeSlot,
  TimeSlotStatus,
  SETTLEMENT_DELAY_HOURS,
} from '@app/common';
import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BookedRehearsalService } from '../../rehearsal/booked-rehearsal.service';
import { buildBookingFinancialState } from './booking-financial-state.util';
import { FeedbackNotificationService } from '../review/feedback-notification.service';
import { RefundOrchestrationService } from './refund-orchestration.service';
import { SettlementService } from './settlement.service';

const NO_SHOW_GRACE_MINUTES = 5;

/** Statuses allowed for admin manual completion (session occurred). */
const ADMIN_COMPLETABLE_STATUSES: BookingStatus[] = [
  BookingStatus.IN_PROGRESS,
  BookingStatus.CONFIRMED,
];

@Injectable()
export class SessionLifecycleService {
  private readonly logger = new Logger(SessionLifecycleService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly refundOrchestrationService: RefundOrchestrationService,
    private readonly bookedRehearsalService: BookedRehearsalService,
    private readonly settlementService: SettlementService,
    private readonly feedbackNotificationService: FeedbackNotificationService,
  ) {}

  // detect no-shows: confirmed bookings where the session window has passed. grace period = sessionDurationMinutes + 5min.
  async detectNoShows(): Promise<number> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const now = new Date();

    // find confirmed bookings whose session end + grace period has passed
    const candidates = await bookingRepo
      .createQueryBuilder('b')
      .where('b.status = :status', { status: BookingStatus.CONFIRMED })
      .andWhere('b.sessionEndUtc IS NOT NULL')
      .getMany();

    let count = 0;
    for (const booking of candidates) {
      const graceEnd = new Date(
        booking.sessionEndUtc.getTime() + NO_SHOW_GRACE_MINUTES * 60 * 1000,
      );
      if (now > graceEnd) {
        booking.status = BookingStatus.NO_SHOW;
        await bookingRepo.save(booking);
        await this.bookedRehearsalService.markCancelledByBookingId(
          booking.id,
          booking,
        );
        count++;
        this.logger.warn(`Booking ${booking.id} marked as no_show`);
      }
    }

    return count;
  }

  // ADMIN: resolve no-show bookings: reader no-show: full refund to actor, actor no-show: reader gets paid, no refund.
  async resolveNoShow(
    bookingId: string,
    noShowBy: 'actor' | 'reader',
    resolvedByUserId?: string,
  ) {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);

    const booking = await bookingRepo.findOne({
      where: { id: bookingId },
    });
    if (!booking || booking.status !== BookingStatus.NO_SHOW) return null;

    const paymentRecord = await paymentRepo.findOne({
      where: { bookingId },
    });

    let refundExecution:
      | Awaited<ReturnType<RefundOrchestrationService['processBookingRefund']>>
      | undefined;

    if (
      noShowBy === 'reader' &&
      paymentRecord?.status === PaymentRecordStatus.SUCCEEDED
    ) {
      // Reader no-show → full refund to actor, reader doesn't get paid
      // RefundOrchestrationService handles reversal strategy based on paymentModel
      refundExecution =
        await this.refundOrchestrationService.processBookingRefund(bookingId, {
          amountCents: paymentRecord.amountCents,
          reason: 'Reader no-show',
          outcomeCode: 'reader_no_show',
        });

      // For separate charges, mark settlement as skipped (reader won't receive money)
      if (
        paymentRecord.paymentModel === 'separate' &&
        paymentRecord.settlementStatus !== 'settled'
      ) {
        paymentRecord.settlementStatus = 'skipped';
        await paymentRepo.save(paymentRecord);
      }

      this.logger.log(
        `No-show resolved: reader absent for booking ${bookingId}. Full refund to actor.`,
      );
    } else if (
      noShowBy === 'actor' &&
      paymentRecord?.status === PaymentRecordStatus.SUCCEEDED
    ) {
      // Actor no-show → reader gets paid, no refund
      if (
        paymentRecord.paymentModel === 'separate' &&
        paymentRecord.settlementStatus !== 'settled'
      ) {
        // For separate charges: trigger immediate settlement to reader
        const settlementResult =
          await this.settlementService.settleBooking(bookingId);
        this.logger.log(
          `No-show resolved: actor absent for booking ${bookingId}. ` +
            `Immediate settlement to reader: ${settlementResult.settled ? 'success' : settlementResult.error}`,
        );
      } else {
        // Destination charges: reader already has the money
        this.logger.log(
          `No-show resolved: actor absent for booking ${bookingId}. Reader paid.`,
        );
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const slotRepo = manager.getRepository(TimeSlot);
      const paymentRepo = manager.getRepository(PaymentRecord);
      booking.noShowBy = noShowBy;
      booking.noShowResolvedAt = new Date();
      booking.noShowResolvedByUserId = resolvedByUserId;
      await manager.getRepository(Booking).save(booking);

      if (booking.timeSlotId) {
        const slot = await slotRepo.findOne({
          where: { id: booking.timeSlotId },
        });
        if (slot) {
          slot.status = TimeSlotStatus.COMPLETED;
          await slotRepo.save(slot);
        }
      }

      // release any sub-slots that were blocked by this booking
      await slotRepo.update(
        { blockedByBookingId: booking.id },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );

      const updatedPaymentRecord = await paymentRepo.findOne({
        where: { bookingId },
      });

      return {
        booking,
        noShowBy,
        resolved: true,
        resolvedAt: booking.noShowResolvedAt,
        resolvedByUserId: booking.noShowResolvedByUserId || null,
        refundExecution,
        financialState: buildBookingFinancialState(
          updatedPaymentRecord,
          booking,
        ),
      };
    });
  }

  /**
   * Admin-only completion with status guard. Rejects terminal or pre-session states.
   */
  async completeBookingForAdmin(bookingId: string): Promise<Booking | null> {
    const booking = await this.dataSource.getRepository(Booking).findOne({
      where: { id: bookingId },
    });
    if (!booking) {
      return null;
    }
    if (
      !ADMIN_COMPLETABLE_STATUSES.includes(booking.status as BookingStatus)
    ) {
      throw new BadRequestException(
        `Booking cannot be completed from status "${booking.status}". Allowed: ${ADMIN_COMPLETABLE_STATUSES.join(', ')}`,
      );
    }
    return this.completeBooking(bookingId);
  }

  // mark a booking as completed. called when both parties confirm the session happened.
  // for separate-charge payments, transitions to AWAITING_SETTLEMENT instead of COMPLETED.
  async completeBooking(bookingId: string): Promise<Booking> {
    const completedBooking = await this.dataSource.transaction(
      async (manager) => {
        const bookingRepo = manager.getRepository(Booking);
        const slotRepo = manager.getRepository(TimeSlot);
        const profileRepo = manager.getRepository(ReaderProfile);
        const paymentRepo = manager.getRepository(PaymentRecord);

        const booking = await bookingRepo.findOne({
          where: { id: bookingId },
        });
        if (!booking) return null;

        // Check if this booking uses separate charges
        const payment = await paymentRepo.findOne({ where: { bookingId } });
        const isSeparateCharge = payment?.paymentModel === 'separate';

        if (isSeparateCharge) {
          // Separate charges: hold in AWAITING_SETTLEMENT until dispute window passes
          booking.status = BookingStatus.AWAITING_SETTLEMENT;
          await bookingRepo.save(booking);

          // Mark payment as eligible for settlement after the dispute window
          payment.settlementStatus = 'eligible';
          payment.settlementEligibleAt = new Date(
            Date.now() + SETTLEMENT_DELAY_HOURS * 60 * 60 * 1000,
          );
          await paymentRepo.save(payment);

          this.logger.log(
            `Booking ${bookingId} awaiting settlement (eligible at ${payment.settlementEligibleAt.toISOString()})`,
          );
        } else {
          // Destination charges (legacy): complete immediately
          booking.status = BookingStatus.COMPLETED;
          booking.completedAt = new Date();
          await bookingRepo.save(booking);
        }

        await this.bookedRehearsalService.markCompleted(
          booking,
          booking.completedAt || new Date(),
          manager,
        );

        // mark slot as completed (only for scheduled bookings)
        if (booking.timeSlotId) {
          const slot = await slotRepo.findOne({
            where: { id: booking.timeSlotId },
          });
          if (slot) {
            slot.status = TimeSlotStatus.COMPLETED;
            await slotRepo.save(slot);
          }
        }

        // increment reader's total sessions
        const profile = await profileRepo.findOne({
          where: { id: booking.readerProfileId },
        });
        if (profile) {
          profile.totalSessions += 1;
          await profileRepo.save(profile);
        }

        this.logger.log(
          `Booking ${bookingId} ${isSeparateCharge ? 'awaiting settlement' : 'completed'}`,
        );
        return booking;
      },
    );

    // fire-and-forget: request feedback outside the transaction so we don't hold a DB lock
    this.feedbackNotificationService
      .requestFeedbackAfterCompletion(completedBooking)
      .catch((err) =>
        this.logger.error(
          `Failed to send feedback request for booking ${bookingId}: ${err.message}`,
        ),
      );

    return completedBooking;
  }

  // get booking detail with timezone-localized session times.
  async getBookingDetail(bookingId: string, userId: string) {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const booking = await bookingRepo.findOne({
      where: { id: bookingId },
    });

    if (!booking) return null;
    if (booking.actorUserId !== userId && booking.readerUserId !== userId) {
      return null;
    }

    // get reader profile for context
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const readerProfile = await profileRepo.findOne({
      where: { id: booking.readerProfileId },
      relations: ['sessionRates'],
    });

    // get payment info
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);
    const payment = await paymentRepo.findOne({
      where: { bookingId },
    });

    return {
      booking,
      readerProfile: readerProfile
        ? {
            id: readerProfile.id,
            userId: readerProfile.userId,
            headline: readerProfile.headline,
            bio: readerProfile.bio,
            avgRating: readerProfile.avgRating,
            totalSessions: readerProfile.totalSessions,
          }
        : null,
      payment: payment
        ? {
            status: payment.status,
            amountCents: payment.amountCents,
            platformFeeCents: payment.platformFeeCents,
            readerPayoutCents: payment.readerPayoutCents,
            currency: payment.currency,
          }
        : null,
    };
  }
}
