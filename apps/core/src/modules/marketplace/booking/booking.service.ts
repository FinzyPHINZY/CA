/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/style/noNonNullAssertion: <> */

import {
  Booking,
  BookingStatus,
  BookingType,
  CalendarProvider,
  CancellationPolicy,
  PaymentRecord,
  ReaderProfile,
  ReaderSessionRate,
  ReaderSpecialty,
  RedisLockService,
  TimeSlot,
  TimeSlotStatus,
  User,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In, IsNull } from 'typeorm';
import { CalendarSyncService } from '../../calendar/calendar-sync.service';
import { IcsGeneratorService } from '../../calendar/ics-generator.service';
import { BookedRehearsalService } from '../../rehearsal/booked-rehearsal.service';
import { buildBookingFinancialState } from './booking-financial-state.util';
import { BookingNotificationService } from './booking-notification.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { FeeCalculationService } from './fee-calculation.service';
import { RefundOrchestrationService } from './refund-orchestration.service';

const SLOT_LOCK_TTL_SECONDS = 30;
const PAYMENT_WINDOW_SECONDS = 600; // 10 minutes for users to complete payment

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisLockService: RedisLockService,
    private readonly feeCalculationService: FeeCalculationService,
    private readonly bookingNotificationService: BookingNotificationService,
    private readonly icsGeneratorService: IcsGeneratorService,
    private readonly calendarSyncService: CalendarSyncService,
    private readonly refundOrchestrationService: RefundOrchestrationService,
    private readonly bookedRehearsalService: BookedRehearsalService,
  ) {}

  // create a booking: validate slot → acquire Redis lock → hold slot → create booking.
  async createBooking(actorUserId: string, dto: CreateBookingDto) {
    const { readerProfileId, timeSlotId, sessionDurationMinutes } = dto;

    // load reader profile and validate
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { id: readerProfileId, isAcceptingBookings: true },
    });
    if (!profile) {
      throw new NotFoundException(
        'Reader profile not found or not accepting bookings',
      );
    }

    // don't allow booking for self
    if (profile.userId === actorUserId) {
      throw new BadRequestException('Cannot book yourself');
    }

    // find matching session rate
    const rateRepo = this.dataSource.getRepository(ReaderSessionRate);
    const rate = await rateRepo.findOne({
      where: {
        readerProfileId,
        durationMinutes: sessionDurationMinutes,
      },
    });
    if (!rate) {
      throw new BadRequestException(
        `Reader does not offer ${sessionDurationMinutes}-minute sessions`,
      );
    }

    // validate time slot
    const slotRepo = this.dataSource.getRepository(TimeSlot);
    const slot = await slotRepo.findOne({ where: { id: timeSlotId } });
    if (!slot) {
      throw new NotFoundException('Time slot not found');
    }
    if (slot.status !== TimeSlotStatus.AVAILABLE) {
      throw new ConflictException('Time slot is no longer available');
    }
    if (!slot.startTimeUtc || slot.startTimeUtc <= new Date()) {
      throw new BadRequestException('Cannot book a slot in the past');
    }

    // acquire Redis lock on the slot
    const lockResult = await this.redisLockService.acquireLock(
      `booking:slot:${timeSlotId}`,
      SLOT_LOCK_TTL_SECONDS,
    );
    if (!lockResult.acquired) {
      throw new ConflictException(
        'This slot is currently being booked by another user. Please try again.',
      );
    }

    try {
      // calculate fees
      const fees = this.feeCalculationService.calculate(rate.priceCents);

      // create booking, hold the booked sub-slot, and block overlapping + buffer sub-slots
      const result = await this.dataSource.transaction(async (manager) => {
        const txSlotRepo = manager.getRepository(TimeSlot);
        const txBookingRepo = manager.getRepository(Booking);

        // double-check slot status inside transaction (postgres safety net)
        const freshSlot = await txSlotRepo.findOne({
          where: { id: timeSlotId },
        });
        if (!freshSlot || freshSlot.status !== TimeSlotStatus.AVAILABLE) {
          throw new ConflictException('Time slot is no longer available');
        }

        // session window is the sub-slot's own start time + requested duration
        const sessionStartUtc = freshSlot.startTimeUtc!;
        const sessionEndUtc = new Date(
          sessionStartUtc.getTime() + sessionDurationMinutes * 60 * 1000,
        );

        // create booking
        const booking = txBookingRepo.create({
          actorUserId,
          readerUserId: profile.userId,
          readerProfileId,
          timeSlotId,
          status: BookingStatus.HELD,
          sessionDurationMinutes,
          priceCents: rate.priceCents,
          currency: rate.currency,
          platformFeeCents: fees.platformFeeCents,
          sessionStartUtc,
          sessionEndUtc,
          extensionAllowed: dto.extensionAllowed ?? true,
        });
        const savedBooking = await txBookingRepo.save(booking);

        // hold the booked sub-slot
        freshSlot.status = TimeSlotStatus.HELD;
        freshSlot.bookingId = savedBooking.id;
        await txSlotRepo.save(freshSlot);

        // block sub-slots that overlap the session window or fall within the buffer
        // covers: any sub-slot whose startTimeUtc falls in [sessionStart, sessionEnd + buffer)
        const bufferMs = (profile.bufferMinutes || 10) * 60 * 1000;
        const bufferEndUtc = new Date(sessionEndUtc.getTime() + bufferMs);

        const slotsToBlock = await txSlotRepo
          .createQueryBuilder('slot')
          .where('slot.availabilityId = :availabilityId', {
            availabilityId: freshSlot.availabilityId,
          })
          .andWhere('slot.id != :bookedSlotId', { bookedSlotId: timeSlotId })
          .andWhere('slot.status = :available', {
            available: TimeSlotStatus.AVAILABLE,
          })
          .andWhere('slot.startTimeUtc >= :sessionStart', {
            sessionStart: sessionStartUtc,
          })
          .andWhere('slot.startTimeUtc < :bufferEnd', {
            bufferEnd: bufferEndUtc,
          })
          .getMany();

        if (slotsToBlock.length > 0) {
          await txSlotRepo.update(
            { id: In(slotsToBlock.map((s) => s.id)) },
            {
              status: TimeSlotStatus.BLOCKED,
              blockedByBookingId: savedBooking.id,
            },
          );
        }

        this.logger.log(
          `Booking ${savedBooking.id} created: held slot ${timeSlotId}, blocked ${slotsToBlock.length} overlapping/buffer sub-slots`,
        );

        return { booking: savedBooking, fees };
      });

      // Release Redis lock now — the DB row in HELD status is the reservation.
      // The lock only needed to prevent concurrent booking of the same slot.
      await this.redisLockService.releaseLock(
        `booking:slot:${timeSlotId}`,
        lockResult.lockToken!,
      );

      const [enrichedBooking] = await this.enrichBookings([result.booking]);
      return {
        success: true,
        message: 'Booking created successfully',
        data: {
          ...result,
          booking: {
            ...enrichedBooking,
            rehearsal: null,
          },
        },
      };
    } catch (error) {
      // release lock on failure
      await this.redisLockService.releaseLock(
        `booking:slot:${timeSlotId}`,
        lockResult.lockToken!,
      );
      throw error;
    }
  }

  // confirm a booking after payment succeeds. Called by payment_intent.succeeded.
  async confirmBooking(bookingId: string): Promise<Booking> {
    const confirmationResult = await this.dataSource.transaction(
      async (manager) => {
        const bookingRepo = manager.getRepository(Booking);
        const slotRepo = manager.getRepository(TimeSlot);

        const booking = await bookingRepo.findOne({
          where: { id: bookingId },
        });
        if (!booking) throw new NotFoundException('Booking not found');

        if (
          booking.status === BookingStatus.CONFIRMED ||
          booking.status === BookingStatus.COMPLETED
        ) {
          if (
            booking.status === BookingStatus.CONFIRMED &&
            booking.timeSlotId
          ) {
            const slot = await slotRepo.findOne({
              where: { id: booking.timeSlotId },
            });
            if (slot && slot.status !== TimeSlotStatus.CONFIRMED) {
              slot.status = TimeSlotStatus.CONFIRMED;
              await slotRepo.save(slot);
            }
          }

          if (booking.status === BookingStatus.CONFIRMED) {
            await this.bookedRehearsalService.ensureForBooking(
              booking,
              manager,
            );
          }
          return { booking, newlyConfirmed: false };
        }

        // Recover bookings that were cancelled by the payment timeout cron
        // but whose payment actually succeeded on Stripe (race condition).
        const isTimeoutCancellation =
          booking.status === BookingStatus.CANCELLED &&
          booking.cancellationReason === 'Payment timeout — hold expired';

        if (booking.status !== BookingStatus.HELD && !isTimeoutCancellation) {
          throw new BadRequestException(
            `Cannot confirm booking with status: ${booking.status}`,
          );
        }

        if (isTimeoutCancellation) {
          this.logger.warn(
            `Recovering timeout-cancelled booking ${bookingId} — payment succeeded on Stripe`,
          );
        }

        // For INSTANT bookings, reset session window to payment-success moment.
        // Why: clock was set at reader-accept time, but actor may spend minutes
        // entering card details. Without reset, that delay eats into session time.
        if (booking.bookingType === BookingType.INSTANT) {
          const paidAt = new Date();
          booking.sessionStartUtc = paidAt;
          booking.sessionEndUtc = new Date(
            paidAt.getTime() + booking.sessionDurationMinutes * 60_000,
          );
        }

        booking.status = BookingStatus.CONFIRMED;
        booking.cancellationReason = null;
        booking.cancelledAt = null;
        booking.cancelledBy = null;
        await bookingRepo.save(booking);

        // confirm the slot (reclaim if it was released back to AVAILABLE)
        if (booking.timeSlotId) {
          const slot = await slotRepo.findOne({
            where: { id: booking.timeSlotId },
          });
          if (slot) {
            if (
              slot.status === TimeSlotStatus.AVAILABLE ||
              slot.status === TimeSlotStatus.HELD
            ) {
              slot.status = TimeSlotStatus.CONFIRMED;
              slot.bookingId = booking.id;
              await slotRepo.save(slot);
            } else if (slot.status !== TimeSlotStatus.CONFIRMED) {
              this.logger.warn(
                `Slot ${slot.id} has unexpected status ${slot.status} during booking confirmation ${bookingId}`,
              );
              slot.status = TimeSlotStatus.CONFIRMED;
              slot.bookingId = booking.id;
              await slotRepo.save(slot);
            }
          }

          // release Redis lock
          await this.redisLockService.releaseLock(
            `booking:slot:${booking.timeSlotId}`,
            '', // lock may have already expired; this is a best-effort release
          );
        }

        // Re-block overlapping/buffer sub-slots.
        // These may have been released by cleanupExpiredHolds (race condition)
        // or were never blocked if this is a recovery from timeout cancellation.
        if (booking.timeSlotId) {
          const bookedSlot = await slotRepo.findOne({
            where: { id: booking.timeSlotId },
          });
          if (bookedSlot) {
            const profileRepo = manager.getRepository(ReaderProfile);
            const profile = await profileRepo.findOne({
              where: { userId: booking.readerUserId },
            });
            const bufferMs =
              ((profile?.bufferMinutes as number) || 10) * 60 * 1000;
            const bufferEndUtc = new Date(
              booking.sessionEndUtc.getTime() + bufferMs,
            );

            const slotsToBlock = await slotRepo
              .createQueryBuilder('slot')
              .where('slot.availabilityId = :availabilityId', {
                availabilityId: bookedSlot.availabilityId,
              })
              .andWhere('slot.id != :bookedSlotId', {
                bookedSlotId: booking.timeSlotId,
              })
              .andWhere('slot.status = :available', {
                available: TimeSlotStatus.AVAILABLE,
              })
              .andWhere('slot.startTimeUtc >= :sessionStart', {
                sessionStart: booking.sessionStartUtc,
              })
              .andWhere('slot.startTimeUtc < :bufferEnd', {
                bufferEnd: bufferEndUtc,
              })
              .getMany();

            if (slotsToBlock.length > 0) {
              await slotRepo.update(
                { id: In(slotsToBlock.map((s) => s.id)) },
                {
                  status: TimeSlotStatus.BLOCKED,
                  blockedByBookingId: booking.id,
                },
              );
              this.logger.log(
                `Re-blocked ${slotsToBlock.length} sub-slots for confirmed booking ${bookingId}`,
              );
            }
          }
        }

        await this.bookedRehearsalService.ensureForBooking(booking, manager);

        this.logger.log(`Booking ${bookingId} confirmed`);
        return { booking, newlyConfirmed: true };
      },
    );

    const confirmed = confirmationResult.booking;
    if (!confirmationResult.newlyConfirmed) {
      return confirmed;
    }

    // emit confirmation notification with ICS attachments (fire-and-forget — does not affect booking outcome)
    try {
      const actorIcs = this.icsGeneratorService.generateBookingIcs(
        confirmed,
        'actor',
      );
      const readerIcs = this.icsGeneratorService.generateBookingIcs(
        confirmed,
        'reader',
      );
      await this.bookingNotificationService.emitBookingStatusChange({
        type: 'booking.confirmed',
        bookingId: confirmed.id,
        actorUserId: confirmed.actorUserId,
        readerUserId: confirmed.readerUserId,
        sessionStartUtc: confirmed.sessionStartUtc.toISOString(),
        sessionEndUtc: confirmed.sessionEndUtc.toISOString(),
        sessionDurationMinutes: confirmed.sessionDurationMinutes,
        priceCents: confirmed.priceCents,
        currency: confirmed.currency,
        actorIcsContent: actorIcs,
        readerIcsContent: readerIcs,
      });
      await this.bookingNotificationService.scheduleReminders(
        confirmed.id,
        confirmed.actorUserId,
        confirmed.readerUserId,
        confirmed.sessionStartUtc,
        confirmed.sessionEndUtc,
        confirmed.sessionDurationMinutes,
        confirmed.priceCents,
        confirmed.currency,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to emit booking.confirmed notification: ${err.message}`,
      );
    }

    // push event to reader's connected calendar (fire-and-forget)
    this.calendarSyncService
      .pushBookingEvent(confirmed.id)
      .catch((err) =>
        this.logger.warn(
          `pushBookingEvent failed for booking ${confirmed.id}: ${err.message}`,
        ),
      );

    return confirmed;
  }

  // handle payment failure — cancel booking and release slot.
  async handlePaymentFailure(bookingId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const slotRepo = manager.getRepository(TimeSlot);

      const booking = await bookingRepo.findOne({
        where: { id: bookingId },
      });
      if (!booking) return;

      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = 'Payment failed';
      booking.cancelledAt = new Date();
      await bookingRepo.save(booking);

      // release the booked sub-slot
      if (booking.timeSlotId) {
        const slot = await slotRepo.findOne({
          where: { id: booking.timeSlotId },
        });
        if (slot) {
          slot.status = TimeSlotStatus.AVAILABLE;
          slot.bookingId = null;
          await slotRepo.save(slot);
        }
      }

      // release all sub-slots blocked by this booking
      await slotRepo.update(
        { blockedByBookingId: booking.id },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );
    });
  }

  // actor cancels a booking — apply cancellation policy for refund calculation.
  async cancelByActor(bookingId: string, actorUserId: string, reason?: string) {
    let refundExecution:
      | Awaited<ReturnType<RefundOrchestrationService['processBookingRefund']>>
      | undefined;

    const result = await this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const slotRepo = manager.getRepository(TimeSlot);
      const profileRepo = manager.getRepository(ReaderProfile);

      const booking = await bookingRepo.findOne({
        where: { id: bookingId },
      });
      if (!booking) throw new NotFoundException('Booking not found');
      if (booking.actorUserId !== actorUserId) {
        throw new ForbiddenException('Not your booking');
      }
      if (
        booking.status !== BookingStatus.CONFIRMED &&
        booking.status !== BookingStatus.HELD &&
        booking.status !== BookingStatus.PENDING_ACCEPTANCE
      ) {
        throw new BadRequestException(
          `Cannot cancel booking with status: ${booking.status}`,
        );
      }

      // get reader's cancellation policy
      const profile = await profileRepo.findOne({
        where: { id: booking.readerProfileId },
      });
      const policy =
        (profile?.cancellationPolicy as CancellationPolicy) ||
        CancellationPolicy.FLEXIBLE;

      // calculate refund based on policy
      const refund = this.calculateRefund(
        booking.priceCents,
        booking.sessionStartUtc,
        policy,
      );

      const wasConfirmed = booking.status === BookingStatus.CONFIRMED;

      if (wasConfirmed && refund.refundCents > 0) {
        // RefundOrchestrationService determines reversal strategy based on paymentModel
        refundExecution =
          await this.refundOrchestrationService.processBookingRefund(
            bookingId,
            {
              amountCents: refund.refundCents,
              reason: refund.reason,
              outcomeCode: 'actor_cancel',
            },
          );
      }

      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = reason || 'Cancelled by actor';
      booking.cancelledBy = 'actor';
      booking.cancelledAt = new Date();
      await bookingRepo.save(booking);
      await this.bookedRehearsalService.markCancelledByBookingId(
        booking.id,
        booking,
        manager,
      );

      // release the booked sub-slot
      if (booking.timeSlotId) {
        const slot = await slotRepo.findOne({
          where: { id: booking.timeSlotId },
        });
        if (slot) {
          slot.status = TimeSlotStatus.AVAILABLE;
          slot.bookingId = null;
          await slotRepo.save(slot);
        }
      }

      // release all sub-slots blocked by this booking
      await slotRepo.update(
        { blockedByBookingId: booking.id },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );

      this.logger.log(
        `Booking ${bookingId} cancelled by actor. Refund: ${refund.refundCents} cents (${refund.refundPercent}%)`,
      );

      return {
        booking,
        refund,
        wasConfirmed,
        refundExecution,
      };
    });

    // remove external calendar event if booking was previously confirmed (fire-and-forget)
    if (result.wasConfirmed) {
      this.calendarSyncService
        .deleteBookingEvent(bookingId, CalendarProvider.GOOGLE)
        .catch(() => {});
    }

    // notify both parties of the cancellation
    this.bookingNotificationService
      .emitBookingStatusChange({
        type: 'booking.cancelled',
        bookingId,
        actorUserId: result.booking.actorUserId,
        readerUserId: result.booking.readerUserId,
        sessionStartUtc: result.booking.sessionStartUtc.toISOString(),
        sessionEndUtc: result.booking.sessionEndUtc.toISOString(),
        sessionDurationMinutes: result.booking.sessionDurationMinutes,
        priceCents: result.booking.priceCents,
        currency: result.booking.currency || 'usd',
        cancellationReason: result.booking.cancellationReason,
        cancelledBy: actorUserId,
      })
      .catch(() => {});

    return {
      success: true,
      message: 'Booking cancelled successfully',
      data: {
        booking: result.booking,
        refund: result.refund,
        refundExecution: result.refundExecution,
      },
    };
  }

  // reader cancels a booking — always full refund to actor.
  async cancelByReader(
    bookingId: string,
    readerUserId: string,
    reason?: string,
  ) {
    let refundExecution:
      | Awaited<ReturnType<RefundOrchestrationService['processBookingRefund']>>
      | undefined;

    const result = await this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const slotRepo = manager.getRepository(TimeSlot);

      const booking = await bookingRepo.findOne({
        where: { id: bookingId },
      });
      if (!booking) throw new NotFoundException('Booking not found');
      if (booking.readerUserId !== readerUserId) {
        throw new ForbiddenException('Not your booking');
      }
      if (
        booking.status !== BookingStatus.CONFIRMED &&
        booking.status !== BookingStatus.HELD &&
        booking.status !== BookingStatus.PENDING_ACCEPTANCE
      ) {
        throw new BadRequestException(
          `Cannot cancel booking with status: ${booking.status}`,
        );
      }

      const wasConfirmed = booking.status === BookingStatus.CONFIRMED;

      if (wasConfirmed) {
        // RefundOrchestrationService determines reversal strategy based on paymentModel
        refundExecution =
          await this.refundOrchestrationService.processBookingRefund(
            bookingId,
            {
              amountCents: booking.priceCents,
              reason: 'Reader cancelled — full refund',
              outcomeCode: 'reader_cancel',
            },
          );
      }

      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = reason || 'Cancelled by reader';
      booking.cancelledBy = 'reader';
      booking.cancelledAt = new Date();
      await bookingRepo.save(booking);
      await this.bookedRehearsalService.markCancelledByBookingId(
        booking.id,
        booking,
        manager,
      );

      // release the booked sub-slot
      if (booking.timeSlotId) {
        const slot = await slotRepo.findOne({
          where: { id: booking.timeSlotId },
        });
        if (slot) {
          slot.status = TimeSlotStatus.AVAILABLE;
          slot.bookingId = null;
          await slotRepo.save(slot);
        }
      }

      // release all sub-slots blocked by this booking
      await slotRepo.update(
        { blockedByBookingId: booking.id },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );

      this.logger.log(`Booking ${bookingId} cancelled by reader. Full refund.`);

      return {
        booking,
        wasConfirmed,
        refund: {
          refundCents: booking.priceCents,
          refundPercent: 100,
          reason: 'Reader cancelled — full refund',
        },
        refundExecution,
      };
    });

    // remove external calendar event if booking was previously confirmed (fire-and-forget)
    if (result.wasConfirmed) {
      this.calendarSyncService
        .deleteBookingEvent(bookingId, CalendarProvider.GOOGLE)
        .catch(() => {});
    }

    // notify both parties of the cancellation
    this.bookingNotificationService
      .emitBookingStatusChange({
        type: 'booking.cancelled',
        bookingId,
        actorUserId: result.booking.actorUserId,
        readerUserId: result.booking.readerUserId,
        sessionStartUtc: result.booking.sessionStartUtc.toISOString(),
        sessionEndUtc: result.booking.sessionEndUtc.toISOString(),
        sessionDurationMinutes: result.booking.sessionDurationMinutes,
        priceCents: result.booking.priceCents,
        currency: result.booking.currency || 'usd',
        cancellationReason: result.booking.cancellationReason,
        cancelledBy: readerUserId,
      })
      .catch(() => {});

    return {
      success: true,
      message: 'Booking cancelled by reader successfully',
      data: {
        booking: result.booking,
        refund: result.refund,
        refundExecution: result.refundExecution,
      },
    };
  }

  // get a booking by ID with authorization check.
  async getBooking(bookingId: string, userId: string) {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);
    const booking = await bookingRepo.findOne({ where: { id: bookingId } });

    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.actorUserId !== userId && booking.readerUserId !== userId) {
      throw new ForbiddenException('Not authorized to view this booking');
    }

    const [paymentRecord, [enrichedBooking]] = await Promise.all([
      paymentRepo.findOne({ where: { bookingId: booking.id } }),
      this.enrichBookings([booking]),
    ]);
    const [bookingWithRehearsal] = await this.attachRehearsalSummaries([
      enrichedBooking,
    ]);

    return {
      success: true,
      message: 'Booking retrieved successfully',
      data: {
        ...bookingWithRehearsal,
        financialState: buildBookingFinancialState(paymentRecord, booking),
      },
    };
  }

  // list bookings for a user (as actor or reader).
  async listBookings(
    userId: string,
    options: {
      role?: 'actor' | 'reader';
      status?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const { role, status, page = 1, limit = 20 } = options;

    const bookingRepo = this.dataSource.getRepository(Booking);
    const qb = bookingRepo.createQueryBuilder('booking');

    if (role === 'actor') {
      qb.where('booking.actorUserId = :userId', { userId });
    } else if (role === 'reader') {
      qb.where('booking.readerUserId = :userId', { userId });
    } else {
      qb.where(
        '(booking.actorUserId = :userId OR booking.readerUserId = :userId)',
        { userId },
      );
    }

    if (status) {
      qb.andWhere('booking.status = :status', { status });
    }

    qb.orderBy('booking.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();
    const [paymentRecords, enrichedData] = await Promise.all([
      data.length
        ? this.dataSource.getRepository(PaymentRecord).find({
            where: { bookingId: In(data.map((booking) => booking.id)) },
          })
        : Promise.resolve([]),
      this.enrichBookings(data),
    ]);
    const bookingsWithRehearsal =
      await this.attachRehearsalSummaries(enrichedData);
    const paymentByBookingId = new Map(
      paymentRecords.map((payment) => [payment.bookingId, payment]),
    );
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Bookings retrieved successfully',
      data: {
        items: bookingsWithRehearsal.map((booking) => ({
          ...booking,
          financialState: buildBookingFinancialState(
            paymentByBookingId.get(booking.id),
            booking,
          ),
        })),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // Cancel held bookings whose payment window has expired. Called periodically by a cron job.
  async cleanupExpiredHolds(): Promise<number> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const slotRepo = this.dataSource.getRepository(TimeSlot);

    // find held bookings older than the payment window
    const cutoff = new Date(Date.now() - PAYMENT_WINDOW_SECONDS * 1000);
    const expiredBookings = await bookingRepo
      .createQueryBuilder('booking')
      .where('booking.status = :status', { status: BookingStatus.HELD })
      .andWhere('booking.createdAt < :cutoff', { cutoff })
      .getMany();

    for (const booking of expiredBookings) {
      booking.status = BookingStatus.CANCELLED;
      booking.cancellationReason = 'Payment timeout — hold expired';
      booking.cancelledAt = new Date();
      await bookingRepo.save(booking);

      if (booking.timeSlotId) {
        const slot = await slotRepo.findOne({
          where: { id: booking.timeSlotId },
        });
        if (slot && slot.status === TimeSlotStatus.HELD) {
          slot.status = TimeSlotStatus.AVAILABLE;
          slot.bookingId = null;
          await slotRepo.save(slot);
        }
      }

      // release all sub-slots blocked by this booking
      await slotRepo.update(
        { blockedByBookingId: booking.id },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );

      this.logger.warn(`Expired held booking cleaned up: ${booking.id}`);
    }

    return expiredBookings.length;
  }

  // --- Admin queries ---

  async listNoShowBookings(options: { page?: number; limit?: number } = {}) {
    const { page = 1, limit = 20 } = options;
    const bookingRepo = this.dataSource.getRepository(Booking);

    const [data, total] = await bookingRepo.findAndCount({
      where: {
        status: BookingStatus.NO_SHOW,
        noShowResolvedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const paymentRecords = data.length
      ? await this.dataSource.getRepository(PaymentRecord).find({
          where: { bookingId: In(data.map((booking) => booking.id)) },
        })
      : [];
    const paymentByBookingId = new Map(
      paymentRecords.map((payment) => [payment.bookingId, payment]),
    );

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'No-show bookings retrieved successfully',
      data: {
        items: data.map((booking) => ({
          ...booking,
          financialState: buildBookingFinancialState(
            paymentByBookingId.get(booking.id),
            booking,
          ),
        })),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // --- Private helpers ---

  // enrich bookings with actor/reader name, avatar, and reader genres.
  private async enrichBookings(bookings: Booking[]) {
    if (bookings.length === 0) return [];

    const userIds = [
      ...new Set([
        ...bookings.map((b) => b.actorUserId),
        ...bookings.map((b) => b.readerUserId),
      ]),
    ];
    const readerProfileIds = [
      ...new Set(bookings.map((b) => b.readerProfileId)),
    ];

    const [users, specialties] = await Promise.all([
      this.dataSource.getRepository(User).find({
        where: { id: In(userIds) },
        select: ['id', 'fullName', 'avatar'],
      }),
      this.dataSource.getRepository(ReaderSpecialty).find({
        where: { readerProfileId: In(readerProfileIds) },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const genreMap = new Map<string, string[]>();
    for (const s of specialties) {
      const list = genreMap.get(s.readerProfileId) ?? [];
      list.push(s.genre);
      genreMap.set(s.readerProfileId, list);
    }

    return bookings.map((booking) => {
      const actorUser = userMap.get(booking.actorUserId);
      const readerUser = userMap.get(booking.readerUserId);
      return {
        ...booking,
        actor: {
          name: actorUser?.fullName ?? null,
          avatar: actorUser?.avatar ?? null,
        },
        reader: {
          name: readerUser?.fullName ?? null,
          avatar: readerUser?.avatar ?? null,
          genres: genreMap.get(booking.readerProfileId) ?? [],
        },
        rehearsal: null,
      };
    });
  }

  private async attachRehearsalSummaries<T extends Booking>(
    bookings: T[],
  ): Promise<Array<T & { rehearsal: Record<string, any> | null }>> {
    if (bookings.length === 0) {
      return [];
    }

    const eligibleBookingIds = bookings
      .filter((booking) => booking.status !== BookingStatus.HELD)
      .map((booking) => booking.id);

    if (eligibleBookingIds.length === 0) {
      return bookings.map((booking) => ({
        ...booking,
        rehearsal: null,
      }));
    }

    const existing =
      await this.bookedRehearsalService.findManyByBookingIds(
        eligibleBookingIds,
      );
    const rehearsalByBookingId = new Map(
      existing
        .filter((rehearsal) => rehearsal.bookingId)
        .map((rehearsal) => [rehearsal.bookingId!, rehearsal]),
    );

    const missingIds = eligibleBookingIds.filter(
      (bookingId) => !rehearsalByBookingId.has(bookingId),
    );

    if (missingIds.length > 0) {
      const bookingMap = new Map(
        bookings.map((booking) => [booking.id, booking]),
      );
      const created = await Promise.all(
        missingIds.map(async (bookingId) => {
          const sourceBooking = bookingMap.get(bookingId);
          if (!sourceBooking) {
            return null;
          }

          try {
            return await this.bookedRehearsalService.ensureForBooking(
              sourceBooking,
            );
          } catch (error: any) {
            this.logger.warn(
              `Failed to lazily backfill rehearsal for booking ${bookingId}: ${error.message}`,
            );
            return null;
          }
        }),
      );

      for (const rehearsal of created) {
        if (!rehearsal?.bookingId) continue;
        rehearsalByBookingId.set(rehearsal.bookingId, rehearsal);
      }
    }

    return bookings.map((booking) => {
      const rehearsal = rehearsalByBookingId.get(booking.id) ?? null;
      return {
        ...booking,
        rehearsal: rehearsal
          ? {
              id: rehearsal.id,
              status: rehearsal.status,
              mode: rehearsal.mode,
              runtimeEngine: rehearsal.runtimeEngine,
            }
          : null,
      };
    });
  }

  // calculate refund amount based on cancellation policy and time until session.
  private calculateRefund(
    priceCents: number,
    sessionStartUtc: Date,
    policy: CancellationPolicy,
  ): { refundCents: number; refundPercent: number; reason: string } {
    const now = new Date();
    const hoursUntilSession =
      (sessionStartUtc.getTime() - now.getTime()) / (1000 * 60 * 60);

    let refundPercent: number;
    let reason: string;

    switch (policy) {
      case CancellationPolicy.FLEXIBLE:
        if (hoursUntilSession > 24) {
          refundPercent = 100;
          reason = 'Full refund (>24h before session)';
        } else if (hoursUntilSession > 12) {
          refundPercent = 50;
          reason = '50% refund (12-24h before session)';
        } else {
          refundPercent = 0;
          reason = 'No refund (<12h before session)';
        }
        break;

      case CancellationPolicy.MODERATE:
        if (hoursUntilSession > 48) {
          refundPercent = 100;
          reason = 'Full refund (>48h before session)';
        } else if (hoursUntilSession > 24) {
          refundPercent = 50;
          reason = '50% refund (24-48h before session)';
        } else {
          refundPercent = 0;
          reason = 'No refund (<24h before session)';
        }
        break;

      case CancellationPolicy.STRICT:
        if (hoursUntilSession > 168) {
          // 7 days
          refundPercent = 100;
          reason = 'Full refund (>7d before session)';
        } else if (hoursUntilSession > 48) {
          refundPercent = 50;
          reason = '50% refund (48h-7d before session)';
        } else {
          refundPercent = 0;
          reason = 'No refund (<48h before session)';
        }
        break;

      default:
        refundPercent = 100;
        reason = 'Full refund (default policy)';
    }

    return {
      refundCents: Math.floor((priceCents * refundPercent) / 100),
      refundPercent,
      reason,
    };
  }
}
