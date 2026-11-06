/** biome-ignore-all lint/style/useImportType: <> */

import { Booking, PaymentRecord, PaymentRecordStatus } from '@app/common';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { DataSource } from 'typeorm';
import {
  ConnectPaymentService,
  RefundPaymentIntentOptions,
} from './connect-payment.service';

export interface ProcessBookingRefundOptions {
  amountCents?: number;
  reason: string;
  outcomeCode: string;
  reverseTransfer?: boolean;
  refundApplicationFee?: boolean;
}

export interface ProcessBookingRefundResult {
  action: 'refunded' | 'skipped';
  booking: Booking;
  paymentRecord: PaymentRecord | null;
  refundId: string | null;
  transferReversalId: string | null;
  refundStatus: string | null;
  reversalStatus: string | null;
  reason: string;
}

interface FinancialIssueRecord {
  state: 'manual_review_required';
  issueCode: string;
  source: 'refund_orchestration' | 'stripe_webhook' | 'admin_retry';
  message: string;
  updatedAt: string;
}

@Injectable()
export class RefundOrchestrationService {
  private readonly logger = new Logger(RefundOrchestrationService.name);

  private stripe: Stripe;

  constructor(
    private readonly dataSource: DataSource,
    private readonly connectPaymentService: ConnectPaymentService,
    private readonly configService: ConfigService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-11-17.clover',
      });
    }
  }

  async processBookingRefund(
    bookingId: string,
    options: ProcessBookingRefundOptions,
  ): Promise<ProcessBookingRefundResult> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const paymentRecordRepo = this.dataSource.getRepository(PaymentRecord);

    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    const paymentRecord = await paymentRecordRepo.findOne({
      where: { bookingId },
    });

    if (!paymentRecord?.stripePaymentIntentId) {
      return {
        action: 'skipped',
        booking,
        paymentRecord: paymentRecord || null,
        refundId: null,
        transferReversalId: null,
        refundStatus: null,
        reversalStatus: null,
        reason: 'No Stripe payment intent found for booking',
      };
    }

    if (
      paymentRecord.status === PaymentRecordStatus.REFUNDED ||
      paymentRecord.status === PaymentRecordStatus.PARTIALLY_REFUNDED ||
      !!paymentRecord.stripeRefundId
    ) {
      return {
        action: 'skipped',
        booking,
        paymentRecord,
        refundId: paymentRecord.stripeRefundId || null,
        transferReversalId: paymentRecord.stripeTransferReversalId || null,
        refundStatus: paymentRecord.refundStatus || null,
        reversalStatus: paymentRecord.reversalStatus || null,
        reason: 'Refund already recorded for booking',
      };
    }

    if (paymentRecord.status !== PaymentRecordStatus.SUCCEEDED) {
      throw new BadRequestException(
        `Cannot refund payment record with status '${paymentRecord.status}'`,
      );
    }

    const refundAmountCents = options.amountCents ?? paymentRecord.amountCents;
    if (refundAmountCents <= 0) {
      return {
        action: 'skipped',
        booking,
        paymentRecord,
        refundId: null,
        transferReversalId: null,
        refundStatus: null,
        reversalStatus: null,
        reason: 'Refund amount is zero',
      };
    }

    const isSeparateCharge = paymentRecord.paymentModel === 'separate';

    // For separate charges, the orchestrator decides reversal strategy internally:
    // - Pre-settlement (not yet settled): simple refund, no reversal needed
    // - Post-settlement (already settled): reverse the transfer first, then refund
    let reverseTransfer: boolean;
    let refundApplicationFee: boolean;

    if (isSeparateCharge) {
      reverseTransfer = false; // never passed to Stripe for separate charges
      refundApplicationFee = false; // no application fee was charged

      // Post-settlement: must reverse the transfer before refunding
      if (
        paymentRecord.settlementStatus === 'settled' &&
        paymentRecord.stripeTransferId
      ) {
        try {
          const reversal = await this.stripe.transfers.createReversal(
            paymentRecord.stripeTransferId,
            {
              amount: Math.round(
                refundAmountCents *
                  (paymentRecord.readerPayoutCents / paymentRecord.amountCents),
              ),
              metadata: { bookingId, reason: options.reason },
            },
          );
          paymentRecord.stripeTransferReversalId = reversal.id;
          paymentRecord.reversalStatus = 'succeeded';
          paymentRecord.reversalCompletedAt = new Date();
          await paymentRecordRepo.save(paymentRecord);
          this.logger.log(
            `[RefundOrchestration] Transfer reversal created for post-settlement refund: booking=${bookingId}, reversal=${reversal.id}`,
          );
        } catch (reversalError: any) {
          this.logger.error(
            `[RefundOrchestration] Transfer reversal failed for booking=${bookingId}: ${reversalError.message}`,
          );
          await this.markFinancialIssue(
            bookingId,
            paymentRecord,
            'transfer_reversal_failed',
            reversalError.message?.slice(0, 1000) || 'Transfer reversal failed',
            'refund_orchestration',
          );
          throw reversalError;
        }
      }
    } else {
      // Destination charges: use caller-provided flags (legacy behavior)
      reverseTransfer = options.reverseTransfer ?? true;
      refundApplicationFee = options.refundApplicationFee ?? true;
    }

    paymentRecord.refundRequestedAt = new Date();
    paymentRecord.refundStatus = 'requested';
    paymentRecord.refundFailureReason = null;
    paymentRecord.refundReason = options.reason;
    paymentRecord.reversalFailureReason = null;
    // Don't overwrite reversalStatus if we already did a manual reversal (post-settlement separate charges)
    if (paymentRecord.reversalStatus !== 'succeeded') {
      paymentRecord.reversalStatus = reverseTransfer
        ? 'requested'
        : 'not_required';
    }
    paymentRecord.refundMetaData = {
      ...(paymentRecord.refundMetaData || {}),
      lastAttempt: {
        bookingId,
        outcomeCode: options.outcomeCode,
        requestedAmountCents: refundAmountCents,
        reverseTransfer,
        refundApplicationFee,
        requestedAt: paymentRecord.refundRequestedAt.toISOString(),
      },
    };
    await paymentRecordRepo.save(paymentRecord);

    this.logger.log(
      `[RefundOrchestration] Refund requested: booking=${bookingId}, paymentIntent=${paymentRecord.stripePaymentIntentId}, outcome=${options.outcomeCode}, amount=${refundAmountCents}, reverseTransfer=${reverseTransfer}, refundApplicationFee=${refundApplicationFee}`,
    );

    if (reverseTransfer) {
      this.logger.log(
        `[RefundOrchestration] Transfer reversal requested: booking=${bookingId}, outcome=${options.outcomeCode}`,
      );
    }

    try {
      const refundOptions: RefundPaymentIntentOptions = {
        amountCents: refundAmountCents,
        reason: options.reason,
        reverseTransfer,
        refundApplicationFee,
        idempotencyResourceKey: this.buildIdempotencyResourceKey(
          bookingId,
          options.outcomeCode,
          refundAmountCents,
        ),
      };

      const refund = await this.connectPaymentService.refundPaymentIntent(
        paymentRecord.stripePaymentIntentId,
        refundOptions,
      );

      const updatedRecord = await paymentRecordRepo.findOne({
        where: { id: paymentRecord.id },
      });

      if (!updatedRecord) {
        throw new NotFoundException('Payment record disappeared after refund');
      }

      updatedRecord.refundStatus = refund.status || 'unknown';
      updatedRecord.stripeRefundId = refund.id;
      updatedRecord.refundAmountCents = refundAmountCents;
      updatedRecord.refundReason = options.reason;
      updatedRecord.refundMetaData = {
        ...(updatedRecord.refundMetaData || {}),
        lastResult: {
          refundId: refund.id,
          refundStatus: refund.status,
          transferReversal:
            typeof refund.transfer_reversal === 'string'
              ? refund.transfer_reversal
              : refund.transfer_reversal?.id,
          sourceTransferReversal:
            typeof refund.source_transfer_reversal === 'string'
              ? refund.source_transfer_reversal
              : refund.source_transfer_reversal?.id,
        },
      };

      const transferReversalId =
        typeof refund.transfer_reversal === 'string'
          ? refund.transfer_reversal
          : refund.transfer_reversal?.id;
      updatedRecord.stripeTransferReversalId = transferReversalId;

      if (refund.status === 'succeeded') {
        updatedRecord.refundedAt = updatedRecord.refundedAt || new Date();
      }

      if (reverseTransfer) {
        updatedRecord.reversalRequestedAt =
          updatedRecord.reversalRequestedAt || new Date();
        updatedRecord.reversalStatus = transferReversalId
          ? 'pending_webhook'
          : 'requested';

        this.logger.log(
          `[RefundOrchestration] Transfer reversal accepted: booking=${bookingId}, refund=${refund.id}, transferReversal=${transferReversalId || 'pending'}`,
        );
      } else {
        updatedRecord.reversalStatus = 'not_required';
      }

      await paymentRecordRepo.save(updatedRecord);
      await this.clearFinancialIssue(bookingId, updatedRecord);

      this.logger.log(
        `Refund processed for booking ${bookingId}: refund=${refund.id}, status=${refund.status}, reversal=${transferReversalId || 'none'}`,
      );

      return {
        action: 'refunded',
        booking,
        paymentRecord: updatedRecord,
        refundId: refund.id,
        transferReversalId: transferReversalId || null,
        refundStatus: updatedRecord.refundStatus || null,
        reversalStatus: updatedRecord.reversalStatus || null,
        reason: options.reason,
      };
    } catch (error: any) {
      const failedRecord = await paymentRecordRepo.findOne({
        where: { id: paymentRecord.id },
      });

      if (failedRecord) {
        failedRecord.refundStatus = 'failed';
        failedRecord.reversalStatus = reverseTransfer
          ? 'not_started'
          : 'not_required';
        failedRecord.refundFailureReason = error.message?.slice(0, 1000);
        failedRecord.refundMetaData = {
          ...(failedRecord.refundMetaData || {}),
          manualReview: {
            required: true,
            issueCode: 'refund_request_failed',
            source: 'refund_orchestration',
            message: error.message?.slice(0, 1000),
            updatedAt: new Date().toISOString(),
          },
        };
        await paymentRecordRepo.save(failedRecord);
        await this.markFinancialIssue(
          bookingId,
          failedRecord,
          'refund_request_failed',
          error.message?.slice(0, 1000) || 'Stripe refund request failed',
          'refund_orchestration',
        );
      }

      this.logger.error(
        `[RefundOrchestration] Refund failed: booking=${bookingId}, outcome=${options.outcomeCode}, message=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private buildIdempotencyResourceKey(
    bookingId: string,
    outcomeCode: string,
    amountCents: number,
  ): string {
    return `booking:${bookingId}:${outcomeCode}:${amountCents}`;
  }

  private async markFinancialIssue(
    bookingId: string,
    paymentRecord: PaymentRecord,
    issueCode: string,
    message: string,
    source: FinancialIssueRecord['source'],
  ): Promise<void> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking) {
      return;
    }

    const financialIssue: FinancialIssueRecord = {
      state: 'manual_review_required',
      issueCode,
      source,
      message,
      updatedAt: new Date().toISOString(),
    };

    booking.metaData = {
      ...(booking.metaData || {}),
      financialIssue,
    };
    await bookingRepo.save(booking);

    paymentRecord.refundMetaData = {
      ...(paymentRecord.refundMetaData || {}),
      manualReview: {
        required: true,
        issueCode,
        source,
        message,
        updatedAt: financialIssue.updatedAt,
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
}
