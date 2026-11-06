/** biome-ignore-all lint/style/useImportType: <> */

import { Booking, PaymentRecord } from '@app/common';

export interface BookingFinancialState {
  paymentStatus: string | null;
  paymentModel: string | null;
  refundStatus: string | null;
  reversalStatus: string | null;
  refundAmountCents: number | null;
  refundReason: string | null;
  stripeRefundId: string | null;
  stripeTransferId: string | null;
  stripeTransferReversalId: string | null;
  settlementStatus: string | null;
  settlementEligibleAt: Date | null;
  settledAt: Date | null;
  actorRefunded: boolean;
  readerPaid: boolean;
  transferReversed: boolean;
  needsManualReview: boolean;
  issueCode: string | null;
  issueMessage: string | null;
  recommendedAction:
    | 'retry_refund'
    | 'retry_settlement'
    | 'manual_stripe_review'
    | null;
}

export function buildBookingFinancialState(
  paymentRecord?: PaymentRecord | null,
  booking?: Booking | null,
): BookingFinancialState {
  const bookingIssue = booking?.metaData?.financialIssue;
  const manualReview = paymentRecord?.refundMetaData?.manualReview;
  const issueCode = bookingIssue?.issueCode || manualReview?.issueCode || null;
  const issueMessage = bookingIssue?.message || manualReview?.message || null;

  let recommendedAction: BookingFinancialState['recommendedAction'] = null;
  if (issueCode === 'refund_failed' || issueCode === 'refund_stuck') {
    recommendedAction = 'retry_refund';
  } else if (paymentRecord?.settlementStatus === 'failed') {
    recommendedAction = 'retry_settlement';
  } else if (issueCode) {
    recommendedAction = 'manual_stripe_review';
  }

  // Derive whether the reader has been paid:
  // - Separate charges: settlementStatus === 'settled'
  // - Destination charges: transfer was created (stripeTransferId exists)
  const readerPaid =
    paymentRecord?.paymentModel === 'separate'
      ? paymentRecord?.settlementStatus === 'settled'
      : !!paymentRecord?.stripeTransferId;

  return {
    paymentStatus: paymentRecord?.status || null,
    paymentModel: paymentRecord?.paymentModel || null,
    refundStatus: paymentRecord?.refundStatus || null,
    reversalStatus: paymentRecord?.reversalStatus || null,
    refundAmountCents: paymentRecord?.refundAmountCents ?? null,
    refundReason: paymentRecord?.refundReason || null,
    stripeRefundId: paymentRecord?.stripeRefundId || null,
    stripeTransferId: paymentRecord?.stripeTransferId || null,
    stripeTransferReversalId: paymentRecord?.stripeTransferReversalId || null,
    settlementStatus: paymentRecord?.settlementStatus || null,
    settlementEligibleAt: paymentRecord?.settlementEligibleAt || null,
    settledAt: paymentRecord?.settledAt || null,
    actorRefunded: !!paymentRecord?.refundedAt,
    readerPaid,
    transferReversed: paymentRecord?.reversalStatus === 'succeeded',
    needsManualReview:
      bookingIssue?.state === 'manual_review_required' ||
      manualReview?.required === true,
    issueCode,
    issueMessage,
    recommendedAction,
  };
}
