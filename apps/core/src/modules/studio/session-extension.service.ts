/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  Booking,
  BookingRepository,
  BookingStatus,
  NOTIFICATIONS_SERVICE,
  PaymentRecord,
  PaymentRecordStatus,
  ReaderProfile,
  ReaderSessionRate,
  RedisLockService,
  SessionExtension,
  SessionExtensionStatus,
  SessionExtensionRepository,
  TimeSlot,
  TimeSlotStatus,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import Stripe from 'stripe';
import { DataSource } from 'typeorm';
import { ConnectPaymentService } from '../marketplace/booking/connect-payment.service';

const MAX_EXTENSIONS_PER_SESSION = 3;
const READER_APPROVAL_TIMEOUT_SECONDS = 60;
const PAYMENT_WINDOW_SECONDS = 120;
const EXTENSION_LOCK_TTL_SECONDS = 30;
const PLATFORM_FEE_PERCENT = 15;

export interface ExtensionOption {
  durationMinutes: number;
  priceCents: number;
  platformFeeCents: number;
  readerReceivesCents: number;
  available: boolean;
  unavailableReason?: string;
}

@Injectable()
export class SessionExtensionService implements OnModuleInit {
  private readonly logger = new Logger(SessionExtensionService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly sessionExtensionRepository: SessionExtensionRepository,
    private readonly redisLockService: RedisLockService,
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly connectPaymentService: ConnectPaymentService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-11-17.clover',
      });
    }
  }

  onModuleInit() {
    this.connectPaymentService.registerExtensionCallbacks({
      activate: (extensionId: string) => this.activateExtension(extensionId),
      fail: (extensionId: string) =>
        this.handleExtensionPaymentFailed(extensionId),
    });
  }

  async requestExtension(
    bookingId: string,
    actorUserId: string,
    durationMinutes: number,
  ) {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    if (booking.actorUserId !== actorUserId) {
      throw new ForbiddenException('Only the actor can request an extension');
    }

    if (booking.status !== BookingStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Cannot extend session with status '${booking.status}'. Session must be in progress.`,
      );
    }

    if (!booking.extensionAllowed) {
      throw new BadRequestException(
        'Extensions are not allowed for this booking',
      );
    }

    // Check reader profile allows extensions
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const readerProfile = await profileRepo.findOne({
      where: { userId: booking.readerUserId },
    });
    if (!readerProfile?.allowSessionExtensions) {
      throw new BadRequestException(
        'This reader does not allow session extensions',
      );
    }

    // Check extension count limit
    if (booking.extensionCount >= MAX_EXTENSIONS_PER_SESSION) {
      throw new BadRequestException(
        `Maximum of ${MAX_EXTENSIONS_PER_SESSION} extensions per session reached`,
      );
    }

    // Check no pending extension
    const pending =
      await this.sessionExtensionRepository.findPendingByBookingId(bookingId);
    if (pending) {
      throw new ConflictException(
        'An extension request is already pending for this booking',
      );
    }

    // Acquire lock
    const lockResult = await this.redisLockService.acquireLock(
      `extension:booking:${bookingId}`,
      EXTENSION_LOCK_TTL_SECONDS,
    );
    if (!lockResult.acquired) {
      throw new ConflictException(
        'Another extension request is being processed',
      );
    }

    try {
      // Check slot conflicts
      const conflictReason = await this.checkSlotConflicts(
        booking,
        durationMinutes,
        readerProfile.bufferMinutes,
      );
      if (conflictReason) {
        throw new BadRequestException(conflictReason);
      }

      // Calculate price pro-rata from reader's session rates
      const priceCents = await this.calculateExtensionPrice(
        readerProfile.id,
        durationMinutes,
      );
      const platformFeeCents = Math.floor(
        (priceCents * PLATFORM_FEE_PERCENT) / 100,
      );

      const newSessionEndUtc = new Date(
        booking.sessionEndUtc.getTime() + durationMinutes * 60 * 1000,
      );

      const extension = await this.sessionExtensionRepository.createEntity({
        bookingId,
        requestedByUserId: actorUserId,
        extensionDurationMinutes: durationMinutes,
        extensionPriceCents: priceCents,
        platformFeeCents,
        currency: booking.currency,
        status: SessionExtensionStatus.REQUESTED,
        previousSessionEndUtc: booking.sessionEndUtc,
        newSessionEndUtc,
        extensionNumber: booking.extensionCount + 1,
        requestedAt: new Date(),
      });

      // Notify reader via WebSocket
      this.notificationsClient.emit('session.extension_requested', {
        extensionId: extension.id,
        bookingId,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
        durationMinutes,
        priceCents,
        platformFeeCents,
        readerReceivesCents: priceCents - platformFeeCents,
        extensionNumber: extension.extensionNumber,
        expiresAt: new Date(
          Date.now() + READER_APPROVAL_TIMEOUT_SECONDS * 1000,
        ).toISOString(),
      });

      this.logger.log(
        `Extension requested: booking=${bookingId}, duration=${durationMinutes}min, price=${priceCents}c`,
      );

      return {
        success: true,
        message: 'Extension request sent to reader',
        data: {
          extension,
          fees: {
            actorPaysCents: priceCents,
            platformFeeCents,
            readerReceivesCents: priceCents - platformFeeCents,
          },
          expiresInSeconds: READER_APPROVAL_TIMEOUT_SECONDS,
        },
      };
    } finally {
      await this.redisLockService.releaseLock(
        `extension:booking:${bookingId}`,
        lockResult.lockToken!,
      );
    }
  }

  async approveExtension(extensionId: string, readerUserId: string) {
    const extension =
      await this.sessionExtensionRepository.findById(extensionId);
    if (!extension) {
      throw new NotFoundException(`Extension ${extensionId} not found`);
    }

    if (extension.status !== SessionExtensionStatus.REQUESTED) {
      throw new BadRequestException(
        `Extension is not in requested status (current: ${extension.status})`,
      );
    }

    const booking = await this.bookingRepository.findById(extension.bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.readerUserId !== readerUserId) {
      throw new ForbiddenException('Only the reader can approve extensions');
    }

    // Check if request has expired
    const elapsed = (Date.now() - extension.requestedAt.getTime()) / 1000;
    if (elapsed > READER_APPROVAL_TIMEOUT_SECONDS) {
      await this.sessionExtensionRepository.updateById(extensionId, {
        status: SessionExtensionStatus.EXPIRED,
        expiredAt: new Date(),
      } as any);
      throw new BadRequestException('Extension request has expired');
    }

    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }

    // Find reader's stripe account
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId: readerUserId },
    });
    if (!profile?.stripeAccountId) {
      throw new BadRequestException(
        'Reader has not completed Stripe onboarding',
      );
    }

    // Update extension status
    await this.sessionExtensionRepository.updateById(extensionId, {
      status: SessionExtensionStatus.APPROVED,
      approvedAt: new Date(),
      approvedByUserId: readerUserId,
    } as any);

    // Create Stripe PaymentIntent for the extension
    const useSeparateCharges =
      this.configService.get<string>('PAYMENT_MODEL') === 'separate';

    const piParams: Stripe.PaymentIntentCreateParams = {
      amount: extension.extensionPriceCents,
      currency: extension.currency.toLowerCase(),
      metadata: {
        bookingId: extension.bookingId,
        extensionId: extension.id,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
        readerStripeAccountId: profile.stripeAccountId,
        type: 'session_extension',
      },
    };

    if (!useSeparateCharges) {
      piParams.application_fee_amount = extension.platformFeeCents;
      piParams.transfer_data = { destination: profile.stripeAccountId };
    }

    const paymentIntent = await this.stripe.paymentIntents.create(piParams);

    // Update extension with PI ID
    await this.sessionExtensionRepository.updateById(extensionId, {
      status: SessionExtensionStatus.PAYMENT_PENDING,
      stripePaymentIntentId: paymentIntent.id,
    } as any);

    // Create PaymentRecord for extension
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    await paymentRecordRepo.save(
      paymentRecordRepo.create({
        bookingId: extension.bookingId,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
        stripePaymentIntentId: paymentIntent.id,
        amountCents: extension.extensionPriceCents,
        platformFeeCents: extension.platformFeeCents,
        readerPayoutCents:
          extension.extensionPriceCents - extension.platformFeeCents,
        currency: extension.currency,
        status: PaymentRecordStatus.PENDING,
        paymentModel: useSeparateCharges ? 'separate' : 'destination',
        settlementStatus: useSeparateCharges ? 'pending' : undefined,
      }),
    );

    // Notify actor with clientSecret
    this.notificationsClient.emit('session.extension_approved', {
      extensionId: extension.id,
      bookingId: extension.bookingId,
      actorUserId: booking.actorUserId,
      readerUserId: booking.readerUserId,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      expiresInSeconds: PAYMENT_WINDOW_SECONDS,
    });

    this.logger.log(
      `Extension approved: extension=${extensionId}, PI=${paymentIntent.id}`,
    );

    return {
      success: true,
      message: 'Extension approved. Payment intent created.',
      data: {
        extensionId,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        expiresInSeconds: PAYMENT_WINDOW_SECONDS,
      },
    };
  }

  async declineExtension(
    extensionId: string,
    readerUserId: string,
    reason?: string,
  ) {
    const extension =
      await this.sessionExtensionRepository.findById(extensionId);
    if (!extension) {
      throw new NotFoundException(`Extension ${extensionId} not found`);
    }

    if (extension.status !== SessionExtensionStatus.REQUESTED) {
      throw new BadRequestException(
        `Extension is not in requested status (current: ${extension.status})`,
      );
    }

    const booking = await this.bookingRepository.findById(extension.bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.readerUserId !== readerUserId) {
      throw new ForbiddenException('Only the reader can decline extensions');
    }

    await this.sessionExtensionRepository.updateById(extensionId, {
      status: SessionExtensionStatus.DECLINED,
      declinedAt: new Date(),
      declineReason: reason || null,
    } as any);

    this.notificationsClient.emit('session.extension_declined', {
      extensionId: extension.id,
      bookingId: extension.bookingId,
      actorUserId: booking.actorUserId,
      readerUserId: booking.readerUserId,
      reason: reason || null,
    });

    this.logger.log(`Extension declined: extension=${extensionId}`);

    return {
      success: true,
      message: 'Extension request declined',
      data: { extensionId },
    };
  }

  async activateExtension(extensionId: string) {
    const extension =
      await this.sessionExtensionRepository.findById(extensionId);
    if (!extension) {
      throw new NotFoundException(`Extension ${extensionId} not found`);
    }

    if (extension.status !== SessionExtensionStatus.PAYMENT_PENDING) {
      this.logger.warn(
        `activateExtension called for extension ${extensionId} with status ${extension.status}`,
      );
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      const extensionRepo = manager.getRepository(SessionExtension);
      const bookingRepo = manager.getRepository(Booking);
      const slotRepo = manager.getRepository(TimeSlot);

      // Activate extension
      await extensionRepo.update(extensionId, {
        status: SessionExtensionStatus.ACTIVE,
        activatedAt: new Date(),
        paymentConfirmedAt: new Date(),
      });

      // Update booking
      const booking = await bookingRepo.findOne({
        where: { id: extension.bookingId },
      });
      if (!booking) return;

      // Snapshot original duration on first extension
      if (booking.originalSessionDurationMinutes == null) {
        booking.originalSessionDurationMinutes = booking.sessionDurationMinutes;
      }

      booking.sessionEndUtc = extension.newSessionEndUtc;
      booking.extensionCount += 1;
      booking.sessionDurationMinutes += extension.extensionDurationMinutes;
      await bookingRepo.save(booking);

      // Block additional time slots in the extension window
      if (booking.timeSlotId) {
        const profileRepo = manager.getRepository(ReaderProfile);
        const profile = await profileRepo.findOne({
          where: { userId: booking.readerUserId },
        });
        const bufferMinutes = profile?.bufferMinutes ?? 10;

        const bufferEndUtc = new Date(
          extension.newSessionEndUtc.getTime() + bufferMinutes * 60 * 1000,
        );

        // Find the availability ID from the booked slot
        const bookedSlot = await slotRepo.findOne({
          where: { id: booking.timeSlotId },
        });
        if (bookedSlot) {
          await slotRepo
            .createQueryBuilder()
            .update(TimeSlot)
            .set({
              status: TimeSlotStatus.BLOCKED,
              blockedByBookingId: booking.id,
            })
            .where('availabilityId = :availabilityId', {
              availabilityId: bookedSlot.availabilityId,
            })
            .andWhere('status = :available', {
              available: TimeSlotStatus.AVAILABLE,
            })
            .andWhere('startTimeUtc >= :extensionStart', {
              extensionStart: extension.previousSessionEndUtc,
            })
            .andWhere('startTimeUtc < :bufferEnd', {
              bufferEnd: bufferEndUtc,
            })
            .andWhere('id != :bookedSlotId', {
              bookedSlotId: booking.timeSlotId,
            })
            .execute();
        }
      }
    });

    // Fetch updated booking for notification
    const booking = await this.bookingRepository.findById(extension.bookingId);
    const minutesRemaining = booking
      ? Math.ceil((extension.newSessionEndUtc.getTime() - Date.now()) / 60_000)
      : null;

    this.notificationsClient.emit('session.extension_activated', {
      extensionId: extension.id,
      bookingId: extension.bookingId,
      actorUserId: booking?.actorUserId,
      readerUserId: booking?.readerUserId,
      newSessionEndUtc: extension.newSessionEndUtc.toISOString(),
      extensionDurationMinutes: extension.extensionDurationMinutes,
      extensionNumber: extension.extensionNumber,
      minutesRemaining,
    });

    this.logger.log(
      `Extension activated: extension=${extensionId}, newEnd=${extension.newSessionEndUtc.toISOString()}`,
    );
  }

  async expireExtension(extensionId: string) {
    const extension =
      await this.sessionExtensionRepository.findById(extensionId);
    if (!extension) return;

    if (
      extension.status !== SessionExtensionStatus.REQUESTED &&
      extension.status !== SessionExtensionStatus.PAYMENT_PENDING
    ) {
      return;
    }

    const wasPaymentPending =
      extension.status === SessionExtensionStatus.PAYMENT_PENDING;

    await this.sessionExtensionRepository.updateById(extensionId, {
      status: SessionExtensionStatus.EXPIRED,
      expiredAt: new Date(),
    } as any);

    // Cancel Stripe PI if payment was pending
    if (wasPaymentPending && extension.stripePaymentIntentId && this.stripe) {
      try {
        await this.stripe.paymentIntents.cancel(
          extension.stripePaymentIntentId,
        );
      } catch (error: any) {
        this.logger.warn(
          `Failed to cancel PI ${extension.stripePaymentIntentId}: ${error.message}`,
        );
      }
    }

    const booking = await this.bookingRepository.findById(extension.bookingId);

    this.notificationsClient.emit('session.extension_expired', {
      extensionId: extension.id,
      bookingId: extension.bookingId,
      actorUserId: booking?.actorUserId,
      readerUserId: booking?.readerUserId,
      reason: wasPaymentPending
        ? 'Payment window expired'
        : 'Reader did not respond in time',
    });

    this.logger.log(
      `Extension expired: extension=${extensionId}, was=${extension.status}`,
    );
  }

  async handleExtensionPaymentFailed(extensionId: string) {
    const extension =
      await this.sessionExtensionRepository.findById(extensionId);
    if (!extension) return;

    await this.sessionExtensionRepository.updateById(extensionId, {
      status: SessionExtensionStatus.FAILED,
    } as any);

    const booking = await this.bookingRepository.findById(extension.bookingId);

    this.notificationsClient.emit('session.extension_failed', {
      extensionId: extension.id,
      bookingId: extension.bookingId,
      actorUserId: booking?.actorUserId,
      readerUserId: booking?.readerUserId,
    });

    this.logger.warn(`Extension payment failed: extension=${extensionId}`);
  }

  async getExtensionOptions(bookingId: string, userId: string): Promise<any> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const isParticipant =
      booking.actorUserId === userId || booking.readerUserId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this booking');
    }

    // Base eligibility checks
    if (booking.status !== BookingStatus.IN_PROGRESS) {
      return {
        success: true,
        data: {
          canExtend: false,
          reason: 'Session is not in progress',
          options: [],
        },
      };
    }

    if (!booking.extensionAllowed) {
      return {
        success: true,
        data: {
          canExtend: false,
          reason: 'Extensions are disabled for this booking',
          options: [],
        },
      };
    }

    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId: booking.readerUserId },
    });
    if (!profile?.allowSessionExtensions) {
      return {
        success: true,
        data: {
          canExtend: false,
          reason: 'Reader does not allow extensions',
          options: [],
        },
      };
    }

    if (booking.extensionCount >= MAX_EXTENSIONS_PER_SESSION) {
      return {
        success: true,
        data: {
          canExtend: false,
          reason: `Maximum of ${MAX_EXTENSIONS_PER_SESSION} extensions reached`,
          options: [],
        },
      };
    }

    const pending =
      await this.sessionExtensionRepository.findPendingByBookingId(bookingId);
    if (pending) {
      return {
        success: true,
        data: {
          canExtend: false,
          reason: 'An extension request is already pending',
          pendingExtension: pending,
          options: [],
        },
      };
    }

    // Build options for each duration
    const options: ExtensionOption[] = [];
    for (const duration of [15, 30]) {
      const conflictReason = await this.checkSlotConflicts(
        booking,
        duration,
        profile.bufferMinutes,
      );

      let priceCents = 0;
      let platformFeeCents = 0;
      try {
        priceCents = await this.calculateExtensionPrice(profile.id, duration);
        platformFeeCents = Math.floor(
          (priceCents * PLATFORM_FEE_PERCENT) / 100,
        );
      } catch {
        // Reader has no rates configured
      }

      options.push({
        durationMinutes: duration,
        priceCents,
        platformFeeCents,
        readerReceivesCents: priceCents - platformFeeCents,
        available: !conflictReason && priceCents > 0,
        unavailableReason:
          conflictReason ||
          (priceCents === 0 ? 'No rate configured for this reader' : undefined),
      });
    }

    return {
      success: true,
      data: {
        canExtend: options.some((o) => o.available),
        extensionCount: booking.extensionCount,
        maxExtensions: MAX_EXTENSIONS_PER_SESSION,
        options,
      },
    };
  }

  async getExtensionHistory(bookingId: string, userId: string) {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const isParticipant =
      booking.actorUserId === userId || booking.readerUserId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this booking');
    }

    const extensions =
      await this.sessionExtensionRepository.findByBookingId(bookingId);

    return {
      success: true,
      message: 'Extension history retrieved',
      data: { extensions },
    };
  }

  // --- Private helpers ---

  private async checkSlotConflicts(
    booking: Booking,
    durationMinutes: number,
    bufferMinutes: number,
  ): Promise<string | null> {
    if (!booking.timeSlotId) return null; // instant bookings have no slots

    const slotRepo = this.dataSource.getRepository(TimeSlot);
    const bookedSlot = await slotRepo.findOne({
      where: { id: booking.timeSlotId },
    });
    if (!bookedSlot) return null;

    const extensionEnd = new Date(
      booking.sessionEndUtc.getTime() + durationMinutes * 60 * 1000,
    );
    const bufferEnd = new Date(
      extensionEnd.getTime() + bufferMinutes * 60 * 1000,
    );

    // Check for any CONFIRMED or HELD slots by a different booking in the extension window
    const conflicting = await slotRepo
      .createQueryBuilder('slot')
      .where('slot.availabilityId = :availabilityId', {
        availabilityId: bookedSlot.availabilityId,
      })
      .andWhere('slot.status IN (:...statuses)', {
        statuses: [TimeSlotStatus.CONFIRMED, TimeSlotStatus.HELD],
      })
      .andWhere('slot.bookingId != :bookingId', {
        bookingId: booking.id,
      })
      .andWhere('slot.startTimeUtc >= :windowStart', {
        windowStart: booking.sessionEndUtc,
      })
      .andWhere('slot.startTimeUtc < :windowEnd', {
        windowEnd: bufferEnd,
      })
      .andWhere('slot.deletedAt IS NULL')
      .getCount();

    if (conflicting > 0) {
      return 'Reader has another booking that conflicts with this extension time';
    }

    return null;
  }

  private async calculateExtensionPrice(
    readerProfileId: string,
    durationMinutes: number,
  ): Promise<number> {
    const rateRepo = this.dataSource.getRepository(ReaderSessionRate);
    const rates = await rateRepo.find({
      where: { readerProfileId },
      order: { durationMinutes: 'ASC' },
    });

    if (rates.length === 0) {
      throw new BadRequestException('Reader has no session rates configured');
    }

    // Find the best rate to derive per-minute pricing.
    // Use the rate whose duration is closest to the extension duration,
    // or the shortest rate as fallback.
    const exactRate = rates.find((r) => r.durationMinutes === durationMinutes);
    if (exactRate) {
      return exactRate.priceCents;
    }

    // Pro-rata from the shortest rate (most granular pricing)
    const baseRate = rates[0];
    const perMinuteCents = baseRate.priceCents / baseRate.durationMinutes;
    return Math.ceil(perMinuteCents * durationMinutes);
  }
}
