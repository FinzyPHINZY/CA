/** biome-ignore-all lint/style/useImportType: <> */

import {
  Booking,
  BookingStatus,
  PaymentRecord,
  PaymentRecordStatus,
  RedisLockService,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { DataSource } from 'typeorm';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly redisLockService: RedisLockService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-11-17.clover',
      });
    }
  }

  /**
   * Settle a booking by transferring the reader's share to their connected account.
   * Only for paymentModel='separate' records in 'eligible' settlement status.
   */
  async settleBooking(
    bookingId: string,
  ): Promise<{ settled: boolean; transferId?: string; error?: string }> {
    const lockKey = `settlement:${bookingId}`;
    const lockResult = await this.redisLockService.acquireLock(lockKey, 30);
    if (!lockResult.acquired) {
      this.logger.warn(`Settlement lock not acquired for booking ${bookingId}`);
      return { settled: false, error: 'Could not acquire lock' };
    }

    try {
      const paymentRepo = this.dataSource.getRepository(PaymentRecord);
      const bookingRepo = this.dataSource.getRepository(Booking);

      const payment = await paymentRepo.findOne({ where: { bookingId } });
      if (!payment) {
        return { settled: false, error: 'Payment record not found' };
      }

      if (payment.paymentModel !== 'separate') {
        return { settled: false, error: 'Not a separate-charge payment' };
      }

      if (payment.settlementStatus === 'settled') {
        return { settled: true, transferId: payment.stripeTransferId };
      }

      if (payment.settlementStatus !== 'eligible') {
        return {
          settled: false,
          error: `Invalid settlement status: ${payment.settlementStatus}`,
        };
      }

      if (payment.status !== PaymentRecordStatus.SUCCEEDED) {
        return {
          settled: false,
          error: `Payment not in succeeded status: ${payment.status}`,
        };
      }

      // Get the reader's Stripe account from payment intent metadata
      const readerStripeAccountId =
        await this.getReaderStripeAccountId(payment);
      if (!readerStripeAccountId) {
        await this.markFailed(payment, 'Reader Stripe account ID not found');
        return { settled: false, error: 'Reader Stripe account ID not found' };
      }

      // Create the transfer to the reader's connected account
      const idempotencyKey = `settlement_${bookingId}`;
      try {
        const transfer = await this.stripe.transfers.create(
          {
            amount: payment.readerPayoutCents,
            currency: payment.currency.toLowerCase(),
            destination: readerStripeAccountId,
            metadata: {
              bookingId,
              paymentIntentId: payment.stripePaymentIntentId,
              type: 'session_settlement',
            },
          },
          { idempotencyKey },
        );

        // Update payment record
        payment.stripeTransferId = transfer.id;
        payment.settlementStatus = 'settled';
        payment.settledAt = new Date();
        payment.status = PaymentRecordStatus.SETTLED;
        payment.settlementMetaData = {
          ...payment.settlementMetaData,
          settledVia: 'settlement_service',
          transferCreatedAt: new Date().toISOString(),
        };
        await paymentRepo.save(payment);

        // Transition booking from AWAITING_SETTLEMENT → COMPLETED
        const booking = await bookingRepo.findOne({ where: { id: bookingId } });
        if (booking && booking.status === BookingStatus.AWAITING_SETTLEMENT) {
          booking.status = BookingStatus.COMPLETED;
          booking.completedAt = new Date();
          await bookingRepo.save(booking);
        }

        this.logger.log(
          `Settlement complete for booking ${bookingId}: transfer ${transfer.id}, ` +
            `${payment.readerPayoutCents} cents to ${readerStripeAccountId}`,
        );

        return { settled: true, transferId: transfer.id };
      } catch (stripeError) {
        await this.markFailed(payment, stripeError.message);
        this.logger.error(
          `Settlement transfer failed for booking ${bookingId}: ${stripeError.message}`,
        );
        return { settled: false, error: stripeError.message };
      }
    } finally {
      await this.redisLockService.releaseLock(lockKey, lockResult.lockToken);
    }
  }

  /**
   * Retry a failed settlement.
   */
  async retrySettlement(
    bookingId: string,
  ): Promise<{ settled: boolean; transferId?: string; error?: string }> {
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);
    const payment = await paymentRepo.findOne({ where: { bookingId } });

    if (!payment || payment.settlementStatus !== 'failed') {
      return { settled: false, error: 'No failed settlement to retry' };
    }

    // Reset to eligible so settleBooking can process it
    payment.settlementStatus = 'eligible';
    await paymentRepo.save(payment);

    return this.settleBooking(bookingId);
  }

  /**
   * Get the current settlement status for a booking.
   */
  async getSettlementStatus(bookingId: string) {
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);
    const payment = await paymentRepo.findOne({ where: { bookingId } });

    if (!payment) return null;

    return {
      bookingId,
      paymentModel: payment.paymentModel,
      settlementStatus: payment.settlementStatus,
      settlementEligibleAt: payment.settlementEligibleAt,
      settledAt: payment.settledAt,
      stripeTransferId: payment.stripeTransferId,
      readerPayoutCents: payment.readerPayoutCents,
      settlementMetaData: payment.settlementMetaData,
    };
  }

  private async getReaderStripeAccountId(
    payment: PaymentRecord,
  ): Promise<string | null> {
    if (!payment.stripePaymentIntentId) return null;

    try {
      const pi = await this.stripe.paymentIntents.retrieve(
        payment.stripePaymentIntentId,
      );
      return (pi.metadata?.readerStripeAccountId as string) || null;
    } catch {
      return null;
    }
  }

  private async markFailed(payment: PaymentRecord, reason: string) {
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);
    const retryCount = (payment.settlementMetaData?.retryCount || 0) + 1;

    payment.settlementStatus = 'failed';
    payment.settlementMetaData = {
      ...payment.settlementMetaData,
      retryCount,
      lastFailureReason: reason,
      lastFailedAt: new Date().toISOString(),
    };
    await paymentRepo.save(payment);
  }
}
