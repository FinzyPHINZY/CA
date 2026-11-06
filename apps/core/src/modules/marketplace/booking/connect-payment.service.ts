/** biome-ignore-all lint/style/useImportType: <> */

import {
  Booking,
  BookingStatus,
  NOTIFICATIONS_SERVICE,
  PaymentRecord,
  PaymentRecordStatus,
  ReaderProfile,
  RedisLockService,
} from '@app/common';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import Stripe from 'stripe';
import { DataSource } from 'typeorm';
import { FeeCalculationService } from './fee-calculation.service';

const IDEMPOTENCY_TTL_SECONDS = 86400; // 24h

export interface RefundPaymentIntentOptions {
  amountCents?: number;
  reason?: string;
  reverseTransfer?: boolean;
  refundApplicationFee?: boolean;
  idempotencyResourceKey?: string;
}

@Injectable()
export class ConnectPaymentService {
  private readonly logger = new Logger(ConnectPaymentService.name);
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly feeCalculationService: FeeCalculationService,
    private readonly redisLockService: RedisLockService,
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

  // create a PaymentIntent for a booking. uses either destination charges (legacy)
  // or separate charges (new) based on the PAYMENT_MODEL env var.
  async createConnectedPaymentIntent(bookingId: string) {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }

    const bookingRepo = this.dataSource.getRepository(Booking);
    const profileRepo = this.dataSource.getRepository(ReaderProfile);

    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== BookingStatus.HELD) {
      throw new BadRequestException('Booking must be in held status to pay');
    }

    const profile = await profileRepo.findOne({
      where: { id: booking.readerProfileId },
    });
    if (!profile?.stripeAccountId) {
      throw new BadRequestException(
        'Reader has not completed Stripe onboarding',
      );
    }

    const fees = this.feeCalculationService.calculate(booking.priceCents);
    const idempotencyKey = await this.getIdempotencyKey('create_pi', bookingId);
    const useSeparateCharges =
      this.configService.get<string>('PAYMENT_MODEL') === 'separate';

    const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
      amount: fees.actorPaysCents,
      currency: booking.currency.toLowerCase(),
      metadata: {
        bookingId: booking.id,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
        readerStripeAccountId: profile.stripeAccountId,
      },
    };

    if (!useSeparateCharges) {
      // Destination charge — money routes to reader immediately
      paymentIntentParams.application_fee_amount = fees.platformFeeCents;
      paymentIntentParams.transfer_data = {
        destination: profile.stripeAccountId,
      };
    }

    const paymentIntent = await this.stripe.paymentIntents.create(
      paymentIntentParams,
      { idempotencyKey },
    );

    // update booking with payment intent ID
    booking.stripePaymentIntentId = paymentIntent.id;
    await bookingRepo.save(booking);

    // create pending PaymentRecord
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    await paymentRecordRepo.save(
      paymentRecordRepo.create({
        bookingId: booking.id,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
        stripePaymentIntentId: paymentIntent.id,
        amountCents: fees.actorPaysCents,
        platformFeeCents: fees.platformFeeCents,
        readerPayoutCents: fees.readerReceivesCents,
        currency: booking.currency,
        status: PaymentRecordStatus.PENDING,
        paymentModel: useSeparateCharges ? 'separate' : 'destination',
        settlementStatus: useSeparateCharges ? 'pending' : undefined,
      }),
    );

    this.logger.log(
      `Created ${useSeparateCharges ? 'separate' : 'destination'} PaymentIntent ${paymentIntent.id} for booking ${bookingId}`,
    );

    return {
      success: true,
      message: 'Payment intent created successfully',
      data: {
        clientSecret: paymentIntent.client_secret!,
        paymentIntentId: paymentIntent.id,
      },
    };
  }

  // retrieve the balance of a connected account.
  async retrieveBalance(connectedAccountId: string): Promise<Stripe.Balance> {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');
    return this.stripe.balance.retrieve({
      stripeAccount: connectedAccountId,
    });
  }

  // refund a PaymentIntent (full or partial).
  // for separate charges: never passes reverse_transfer or refund_application_fee
  // (no auto-transfer exists, and no application fee was charged at payment time).
  async refundPaymentIntent(
    paymentIntentId: string,
    options: RefundPaymentIntentOptions = {},
  ): Promise<Stripe.Refund> {
    if (!this.stripe) throw new BadRequestException('Stripe is not configured');

    const {
      amountCents,
      reason,
      reverseTransfer,
      refundApplicationFee,
      idempotencyResourceKey,
    } = options;

    // Check if this is a separate-charge payment
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const record = await paymentRecordRepo.findOne({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    const isSeparateCharge = record?.paymentModel === 'separate';

    const idempotencyKey = await this.getIdempotencyKey(
      'refund',
      idempotencyResourceKey || paymentIntentId,
    );

    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId,
    };
    if (amountCents) {
      refundParams.amount = amountCents;
    }

    // For separate charges: simple refund only — no transfer to reverse, no app fee to refund
    if (!isSeparateCharge) {
      if (reverseTransfer !== undefined) {
        refundParams.reverse_transfer = reverseTransfer;
      }
      if (refundApplicationFee !== undefined) {
        refundParams.refund_application_fee = refundApplicationFee;
      }
    }

    const refund = await this.stripe.refunds.create(refundParams, {
      idempotencyKey,
    });

    // update PaymentRecord (re-fetch to get latest state)
    const freshRecord = await paymentRecordRepo.findOne({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (freshRecord) {
      freshRecord.refundAmountCents = amountCents || freshRecord.amountCents;
      freshRecord.refundReason = reason || 'Refund processed';
      freshRecord.refundedAt = new Date();
      freshRecord.stripeRefundId = refund.id;
      freshRecord.refundStatus = refund.status || 'unknown';

      if (isSeparateCharge) {
        // Separate charges: no transfer reversal, mark settlement as skipped
        freshRecord.reversalStatus = 'not_required';
        freshRecord.settlementStatus = 'skipped';
      } else {
        freshRecord.stripeTransferReversalId =
          typeof refund.transfer_reversal === 'string'
            ? refund.transfer_reversal
            : refund.transfer_reversal?.id;
        if (reverseTransfer) {
          freshRecord.reversalStatus = freshRecord.stripeTransferReversalId
            ? 'pending_webhook'
            : 'requested';
        } else {
          freshRecord.reversalStatus = 'not_required';
        }
      }

      freshRecord.status =
        amountCents && amountCents < freshRecord.amountCents
          ? PaymentRecordStatus.PARTIALLY_REFUNDED
          : PaymentRecordStatus.REFUNDED;
      await paymentRecordRepo.save(freshRecord);
    }

    this.logger.log(
      `Refund ${refund.id} created for PaymentIntent ${paymentIntentId}` +
        (amountCents ? ` (${amountCents} cents)` : ' (full)'),
    );

    return refund;
  }

  // --- Extension payment callback ---
  // Injected lazily to avoid circular dependency (StudioModule imports MarketplaceModule).
  private sessionExtensionCallback:
    | {
        activate: (extensionId: string) => Promise<void>;
        fail: (extensionId: string) => Promise<void>;
      }
    | undefined;

  registerExtensionCallbacks(callbacks: {
    activate: (extensionId: string) => Promise<void>;
    fail: (extensionId: string) => Promise<void>;
  }) {
    this.sessionExtensionCallback = callbacks;
  }

  // connect webhook handlers

  // handle payment_intent.succeeded — confirm booking, create/update PaymentRecord.
  async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const bookingId = paymentIntent.metadata?.bookingId;
    if (!bookingId) return; // Not a marketplace payment

    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const record = await paymentRecordRepo.findOne({
      where: { stripePaymentIntentId: paymentIntent.id },
    });
    if (record) {
      record.status = PaymentRecordStatus.SUCCEEDED;
      await paymentRecordRepo.save(record);
    }

    // Handle extension payments
    const extensionId = paymentIntent.metadata?.extensionId;
    if (extensionId && this.sessionExtensionCallback) {
      await this.sessionExtensionCallback.activate(extensionId);
      this.logger.log(
        `Extension payment succeeded: extension=${extensionId}, PI=${paymentIntent.id}`,
      );
      return;
    }

    // Notify reader of payment received for booking
    try {
      const bookingRepo = this.dataSource.getRepository(Booking);
      const booking = await bookingRepo.findOne({ where: { id: bookingId } });
      if (booking?.readerUserId) {
        const { platformFeeCents } = this.feeCalculationService.calculate(
          booking.priceCents,
        );
        this.notificationsClient.emit('payment.received', {
          readerUserId: booking.readerUserId,
          bookingId,
          amountCents: booking.priceCents,
          platformFeeCents,
          earningsCents: booking.priceCents - platformFeeCents,
          currency: booking.currency || 'usd',
          sessionDurationMinutes: booking.sessionDurationMinutes,
          paymentType: 'booking',
        });
      }
    } catch (notifyError) {
      this.logger.error(
        `Failed to emit payment.received: ${notifyError.message}`,
      );
    }

    this.logger.log(
      `PaymentIntent ${paymentIntent.id} succeeded for booking ${bookingId}`,
    );
  }

  // handle payment_intent.payment_failed — cancel booking.
  async handlePaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent,
  ): Promise<void> {
    const bookingId = paymentIntent.metadata?.bookingId;
    if (!bookingId) return;

    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const record = await paymentRecordRepo.findOne({
      where: { stripePaymentIntentId: paymentIntent.id },
    });
    if (record) {
      record.status = PaymentRecordStatus.FAILED;
      await paymentRecordRepo.save(record);
    }

    // Handle extension payment failures
    const extensionId = paymentIntent.metadata?.extensionId;
    if (extensionId && this.sessionExtensionCallback) {
      await this.sessionExtensionCallback.fail(extensionId);
      this.logger.warn(
        `Extension payment failed: extension=${extensionId}, PI=${paymentIntent.id}`,
      );
      return;
    }

    this.logger.warn(
      `Payment failed for booking ${bookingId}, PaymentIntent ${paymentIntent.id}`,
    );
  }

  // handle transfer.created — store transfer ID on PaymentRecord.
  // for separate-charge records, also mark settlement as settled.
  async handleTransferCreated(transfer: Stripe.Transfer): Promise<void> {
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const bookingId = (transfer.metadata as any)?.bookingId;

    // Try to find by bookingId from metadata first (separate charges set this)
    let record: PaymentRecord | null = null;
    if (bookingId) {
      record = await paymentRecordRepo.findOne({ where: { bookingId } });
    }

    // Fallback: find by source_transaction (destination charges)
    if (!record) {
      const paymentIntentId =
        typeof transfer.source_transaction === 'string'
          ? transfer.source_transaction
          : (transfer.source_transaction as any)?.id;
      if (paymentIntentId) {
        record = await paymentRecordRepo.findOne({
          where: { stripePaymentIntentId: paymentIntentId },
        });
      }
    }

    if (record) {
      record.stripeTransferId = transfer.id;

      // For separate-charge records, confirm settlement via webhook
      if (record.paymentModel === 'separate') {
        record.settlementStatus = 'settled';
        record.settledAt = record.settledAt || new Date();
        record.status = PaymentRecordStatus.SETTLED;
      }

      await paymentRecordRepo.save(record);
    }

    this.logger.log(
      `Transfer ${transfer.id} created${record?.paymentModel === 'separate' ? ' (settlement confirmed)' : ''}`,
    );
  }

  // handle transfer.failed — mark settlement as failed for retry.
  async handleTransferFailed(transfer: Stripe.Transfer): Promise<void> {
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const bookingId = (transfer.metadata as any)?.bookingId;

    if (!bookingId) {
      this.logger.warn(
        `[ConnectPayment] transfer.failed received without bookingId metadata: transfer=${transfer.id}`,
      );
      return;
    }

    const record = await paymentRecordRepo.findOne({ where: { bookingId } });
    if (!record) {
      this.logger.warn(
        `[ConnectPayment] transfer.failed but no payment record found: booking=${bookingId}, transfer=${transfer.id}`,
      );
      return;
    }

    if (record.paymentModel === 'separate') {
      record.settlementStatus = 'failed';
      record.settlementMetaData = {
        ...(record.settlementMetaData || {}),
        retryCount: (record.settlementMetaData?.retryCount || 0) + 1,
        lastFailureReason: 'Transfer failed (Stripe webhook)',
        lastFailedAt: new Date().toISOString(),
      };
      await paymentRecordRepo.save(record);
      this.logger.warn(
        `[ConnectPayment] Settlement transfer failed: booking=${bookingId}, transfer=${transfer.id}. Queued for retry.`,
      );
    }
  }

  // handle transfer.reversed — mark payment record as refunded.
  async handleTransferReversed(transfer: Stripe.Transfer): Promise<void> {
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const record = await paymentRecordRepo.findOne({
      where: { stripeTransferId: transfer.id },
    });
    if (record) {
      record.status = PaymentRecordStatus.REFUNDED;
      record.refundedAt = new Date();
      record.refundReason = 'Transfer reversed';
      record.reversalStatus = 'succeeded';
      record.reversalCompletedAt = new Date();
      await paymentRecordRepo.save(record);
      await this.clearFinancialIssue(record.bookingId, record);
      this.logger.log(
        `[ConnectPayment] Transfer reversal completed: booking=${record.bookingId}, transfer=${transfer.id}, reversalStatus=${record.reversalStatus}`,
      );
      return;
    }
    this.logger.warn(
      `[ConnectPayment] Transfer reversed but no payment record matched transfer=${transfer.id}`,
    );
  }

  async handleRefundUpdated(refund: Stripe.Refund): Promise<void> {
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const paymentIntentId =
      typeof refund.payment_intent === 'string'
        ? refund.payment_intent
        : refund.payment_intent?.id;

    let record = await paymentRecordRepo.findOne({
      where: { stripeRefundId: refund.id },
    });

    if (!record && paymentIntentId) {
      record = await paymentRecordRepo.findOne({
        where: { stripePaymentIntentId: paymentIntentId },
      });
    }

    if (!record) {
      this.logger.warn(
        `[ConnectPayment] Refund webhook received with no matching payment record: refund=${refund.id}, paymentIntent=${paymentIntentId || 'unknown'}`,
      );
      return;
    }

    record.stripeRefundId = refund.id;
    record.refundAmountCents = refund.amount;
    record.refundReason =
      record.refundReason || refund.reason || 'Refund processed';
    record.refundStatus = refund.status || 'unknown';
    record.refundFailureReason = refund.failure_reason || null;
    record.refundMetaData = {
      ...(record.refundMetaData || {}),
      webhook: {
        refundId: refund.id,
        refundStatus: refund.status,
        failureReason: refund.failure_reason || null,
      },
    };

    // For separate charges, refunds don't involve transfer reversals (no auto-transfer exists)
    if (record.paymentModel !== 'separate') {
      const transferReversalId =
        typeof refund.transfer_reversal === 'string'
          ? refund.transfer_reversal
          : refund.transfer_reversal?.id;
      if (transferReversalId) {
        record.stripeTransferReversalId = transferReversalId;
        if (record.reversalStatus !== 'succeeded') {
          record.reversalStatus = 'pending_webhook';
        }
        record.reversalRequestedAt = record.reversalRequestedAt || new Date();
      } else if (!record.reversalStatus) {
        record.reversalStatus = 'not_required';
      }
    } else {
      record.reversalStatus = 'not_required';
    }

    if (refund.status === 'succeeded') {
      record.refundedAt = record.refundedAt || new Date(refund.created * 1000);
      record.status =
        refund.amount < record.amountCents
          ? PaymentRecordStatus.PARTIALLY_REFUNDED
          : PaymentRecordStatus.REFUNDED;
      await paymentRecordRepo.save(record);
      await this.clearFinancialIssue(record.bookingId, record);
    } else {
      // Refund lifecycle is not complete yet; keep the underlying charge marked as paid.
      record.status = PaymentRecordStatus.SUCCEEDED;
      if (refund.status === 'failed' || refund.status === 'canceled') {
        if (record.reversalStatus === 'pending_webhook') {
          record.reversalStatus = 'failed';
          record.reversalFailureReason =
            record.reversalFailureReason || refund.failure_reason || null;
        }
        await paymentRecordRepo.save(record);
        await this.markFinancialIssue(
          record.bookingId,
          record,
          refund.status === 'failed' ? 'refund_failed' : 'refund_canceled',
          refund.failure_reason ||
            `Stripe reported refund status '${refund.status}'`,
          'stripe_webhook',
        );
        this.logger.log(
          `[ConnectPayment] Refund reconciled: booking=${record.bookingId}, refund=${refund.id}, status=${record.refundStatus}, paymentStatus=${record.status}`,
        );
        return;
      }
    }

    await paymentRecordRepo.save(record);

    this.logger.log(
      `[ConnectPayment] Refund reconciled: booking=${record.bookingId}, refund=${refund.id}, status=${record.refundStatus}, paymentStatus=${record.status}`,
    );
  }

  async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const paymentIntentId =
      typeof charge.payment_intent === 'string'
        ? charge.payment_intent
        : charge.payment_intent?.id;

    if (!paymentIntentId) {
      this.logger.warn(
        `[ConnectPayment] charge.refunded received without payment_intent: charge=${charge.id}`,
      );
      return;
    }

    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);
    const record = await paymentRecordRepo.findOne({
      where: { stripePaymentIntentId: paymentIntentId },
    });

    if (!record) {
      this.logger.warn(
        `[ConnectPayment] charge.refunded received with no matching payment record: charge=${charge.id}, paymentIntent=${paymentIntentId}`,
      );
      return;
    }

    record.refundAmountCents = charge.amount_refunded;
    record.refundedAt = record.refundedAt || new Date(charge.created * 1000);
    record.status =
      charge.amount_refunded < record.amountCents
        ? PaymentRecordStatus.PARTIALLY_REFUNDED
        : PaymentRecordStatus.REFUNDED;

    const latestRefund = charge.refunds?.data?.[0];
    if (latestRefund) {
      record.stripeRefundId = latestRefund.id;
      record.refundStatus =
        latestRefund.status || record.refundStatus || 'unknown';
      record.refundFailureReason =
        latestRefund.failure_reason || record.refundFailureReason || null;

      // For separate charges, no auto-transfer exists so skip reversal tracking
      if (record.paymentModel !== 'separate') {
        const transferReversalId =
          typeof latestRefund.transfer_reversal === 'string'
            ? latestRefund.transfer_reversal
            : latestRefund.transfer_reversal?.id;
        if (transferReversalId) {
          record.stripeTransferReversalId = transferReversalId;
          if (record.reversalStatus !== 'succeeded') {
            record.reversalStatus = 'pending_webhook';
          }
        }
      }
    }

    await paymentRecordRepo.save(record);
    await this.clearFinancialIssue(record.bookingId, record);

    this.logger.log(
      `[ConnectPayment] Charge refund reconciled: booking=${record.bookingId}, charge=${charge.id}, amountRefunded=${charge.amount_refunded}`,
    );
  }

  private async markFinancialIssue(
    bookingId: string,
    paymentRecord: PaymentRecord,
    issueCode: string,
    message: string,
    source: 'stripe_webhook',
  ): Promise<void> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (booking) {
      booking.metaData = {
        ...(booking.metaData || {}),
        financialIssue: {
          state: 'manual_review_required',
          issueCode,
          source,
          message,
          updatedAt: new Date().toISOString(),
        },
      };
      await bookingRepo.save(booking);
    }

    paymentRecord.refundMetaData = {
      ...(paymentRecord.refundMetaData || {}),
      manualReview: {
        required: true,
        issueCode,
        source,
        message,
        updatedAt: new Date().toISOString(),
      },
    };
    await this.dataSource.getRepository(PaymentRecord).save(paymentRecord);
  }

  private async clearFinancialIssue(
    bookingId: string,
    paymentRecord: PaymentRecord,
  ): Promise<void> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (booking?.metaData?.financialIssue) {
      const nextMetaData = { ...(booking.metaData || {}) };
      delete nextMetaData.financialIssue;
      booking.metaData = Object.keys(nextMetaData).length ? nextMetaData : null;
      await bookingRepo.save(booking);
    }

    if (paymentRecord.refundMetaData?.manualReview) {
      const nextRefundMetaData = { ...(paymentRecord.refundMetaData || {}) };
      delete nextRefundMetaData.manualReview;
      paymentRecord.refundMetaData = Object.keys(nextRefundMetaData).length
        ? nextRefundMetaData
        : null;
      await this.dataSource.getRepository(PaymentRecord).save(paymentRecord);
    }
  }

  // --- Payment History & Earnings ---

  // get payment history for a user (actor or reader).
  async getPaymentHistory(
    userId: string,
    options: { role?: 'actor' | 'reader'; page?: number; limit?: number } = {},
  ) {
    const { role, page = 1, limit = 20 } = options;
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);

    const qb = paymentRecordRepo.createQueryBuilder('pr');

    if (role === 'actor') {
      qb.where('pr.actorUserId = :userId', { userId });
    } else if (role === 'reader') {
      qb.where('pr.readerUserId = :userId', { userId });
    } else {
      qb.where('(pr.actorUserId = :userId OR pr.readerUserId = :userId)', {
        userId,
      });
    }

    qb.orderBy('pr.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);

    const [data, total] = await qb.getManyAndCount();
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Payment history retrieved successfully',
      data: {
        items: data,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // get reader earnings dashboard data.
  // totalEarnedCents: money the reader has actually received
  //   - destination charges: status = 'succeeded' (auto-transferred at charge time)
  //   - separate charges: settlementStatus = 'settled' (transferred by settlement service)
  // pendingPayoutCents: money the reader will receive once the settlement window passes
  //   - destination charges: status = 'pending' (payment still processing)
  //   - separate charges: settlementStatus IN ('pending', 'eligible') for active bookings
  async getReaderEarnings(userId: string) {
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);

    const result = await paymentRecordRepo
      .createQueryBuilder('pr')
      .select([
        // totalEarnedCents: destination succeeded + separate settled
        `COALESCE(SUM(CASE
          WHEN pr.paymentModel = 'separate' AND pr.settlementStatus = 'settled' THEN pr.readerPayoutCents
          WHEN (pr.paymentModel = 'destination' OR pr.paymentModel IS NULL) AND pr.status = :succeeded THEN pr.readerPayoutCents
          ELSE 0
        END), 0) AS "totalEarnedCents"`,
        // pendingPayoutCents: destination pending + separate pending/eligible
        `COALESCE(SUM(CASE
          WHEN pr.paymentModel = 'separate' AND pr.settlementStatus IN ('pending', 'eligible') AND pr.status = :succeeded THEN pr.readerPayoutCents
          WHEN (pr.paymentModel = 'destination' OR pr.paymentModel IS NULL) AND pr.status = :pending THEN pr.readerPayoutCents
          ELSE 0
        END), 0) AS "pendingPayoutCents"`,
        `COALESCE(SUM(CASE WHEN pr.status IN (:succeeded, :settled) THEN pr.platformFeeCents ELSE 0 END), 0) AS "totalPlatformFeesCents"`,
        `COUNT(CASE WHEN pr.status IN (:succeeded, :settled) THEN 1 END) AS "completedPayments"`,
        'COALESCE(SUM(CASE WHEN pr.status = :refunded OR pr.status = :partiallyRefunded THEN pr.refundAmountCents ELSE 0 END), 0) AS "totalRefundedCents"',
      ])
      .where('pr.readerUserId = :userId', { userId })
      .setParameter('succeeded', PaymentRecordStatus.SUCCEEDED)
      .setParameter('settled', PaymentRecordStatus.SETTLED)
      .setParameter('pending', PaymentRecordStatus.PENDING)
      .setParameter('refunded', PaymentRecordStatus.REFUNDED)
      .setParameter('partiallyRefunded', PaymentRecordStatus.PARTIALLY_REFUNDED)
      .getRawOne();

    return {
      success: true,
      message: 'Reader earnings retrieved successfully',
      data: {
        totalEarnedCents: parseInt(result?.totalEarnedCents || '0', 10),
        pendingPayoutCents: parseInt(result?.pendingPayoutCents || '0', 10),
        totalPlatformFeesCents: parseInt(
          result?.totalPlatformFeesCents || '0',
          10,
        ),
        completedPayments: parseInt(result?.completedPayments || '0', 10),
        totalRefundedCents: parseInt(result?.totalRefundedCents || '0', 10),
        currency: 'USD',
      },
    };
  }

  // generate and cache an idempotency key for Stripe API calls.
  private async getIdempotencyKey(
    action: string,
    resourceId: string,
  ): Promise<string> {
    const key = `idempotency:${action}:${resourceId}`;
    const existing = await this.redisLockService.get(key);
    if (existing) return existing;

    const idempotencyKey = `${action}:${resourceId}:${Date.now()}`;
    await this.redisLockService.setWithTTL(
      key,
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    return idempotencyKey;
  }
}
