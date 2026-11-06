import {
  Booking,
  PaymentRecord,
  PaymentRecordStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@app/common';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  buildBookingFinancialState,
  BookingFinancialState,
} from '../marketplace/booking/booking-financial-state.util';
import { RefundOrchestrationService } from '../marketplace/booking/refund-orchestration.service';
import { SettlementService } from '../marketplace/booking/settlement.service';
import { PaymentsSummaryDto } from './dto/payments-summary.dto';
import { Subscription } from '../subscription/entities/subscription.entity';
import {
  ADMIN_PAYMENT_RECORD_ALIAS,
  ADMIN_SUBSCRIPTION_ALIAS,
} from './admin-query-aliases';

/** Monthly price in USD per plan (used for MRR calculation) */
const PLAN_MONTHLY_PRICE: Record<SubscriptionPlan, number> = {
  [SubscriptionPlan.FREE]: 0,
  [SubscriptionPlan.STARTER]: 45,
  [SubscriptionPlan.PREMIUM]: 80,
  [SubscriptionPlan.ALL_ACCESS]: 99,
};

export interface PaymentReconciliationIssue {
  bookingId: string;
  paymentRecordId: string;
  bookingStatus: string | null;
  paymentStatus: string;
  refundStatus: string | null;
  reversalStatus: string | null;
  refundFailureReason: string | null;
  reversalFailureReason: string | null;
  issueCode:
    | 'refund_failed'
    | 'reversal_failed'
    | 'refund_stuck'
    | 'reversal_stuck';
  recommendedAction: 'retry_refund' | 'manual_stripe_review';
  requestedAt: Date | null;
  lastUpdatedAt: Date;
}

export interface SettlementReconciliationIssue {
  bookingId: string;
  paymentRecordId: string;
  bookingStatus: string | null;
  paymentModel: string | null;
  settlementStatus: string | null;
  settlementEligibleAt: Date | null;
  issueCode: 'settlement_failed' | 'settlement_overdue';
  recommendedAction: 'retry_settlement' | 'manual_stripe_review';
  lastUpdatedAt: Date;
}

export interface FinancialReconciliationIssue {
  bookingId: string;
  paymentRecordId: string;
  bookingStatus: string | null;
  paymentModel: string | null;
  settlementStatus: string | null;
  issueCode: string | null;
  issueMessage: string | null;
  recommendedAction: BookingFinancialState['recommendedAction'];
  needsManualReview: boolean;
  financialState: BookingFinancialState;
  lastUpdatedAt: Date;
}

@Injectable()
export class AdminPaymentsService {
  private readonly logger = new Logger(AdminPaymentsService.name);
  private subscriptionsTableAvailable: boolean | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly refundOrchestrationService: RefundOrchestrationService,
    private readonly settlementService: SettlementService,
  ) {}

  /**
   * Older/stale environments may not yet have billing_schema.subscriptions.
   * Guard summary queries to avoid throwing 500 for the whole endpoint.
   */
  private async hasSubscriptionsTable(): Promise<boolean> {
    if (this.subscriptionsTableAvailable !== null) {
      return this.subscriptionsTableAvailable;
    }
    try {
      const result = await this.dataSource.query(
        "SELECT to_regclass('billing_schema.subscriptions') IS NOT NULL AS exists",
      );
      const existsValue = result?.[0]?.exists;
      this.subscriptionsTableAvailable =
        existsValue === true || existsValue === 't' || existsValue === 1;
    } catch (error) {
      this.logger.warn(
        `Unable to verify billing_schema.subscriptions availability; defaulting subscription metrics to zero: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.subscriptionsTableAvailable = false;
    }
    return this.subscriptionsTableAvailable;
  }

  async getPaymentsSummary(): Promise<PaymentsSummaryDto> {
    const now = new Date();
    const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const hasSubscriptionsTable = await this.hasSubscriptionsTable();

    const [
      totalActiveSubs,
      newActiveThisMonth,
      churnedThisMonth,
      mrr,
      mrrFromNew,
      mrrFromChurned,
      refundsTotalCents,
      failedPaymentsCount,
    ] = await Promise.all([
      hasSubscriptionsTable ? this.countActiveSubscriptions() : 0,
      hasSubscriptionsTable
        ? this.countNewActiveSubscriptionsThisMonth(startOfCurrentMonth)
        : 0,
      hasSubscriptionsTable
        ? this.countChurnedSubscriptionsThisMonth(startOfCurrentMonth)
        : 0,
      hasSubscriptionsTable ? this.computeMRR() : 0,
      hasSubscriptionsTable
        ? this.computeMRRFromNewActiveThisMonth(startOfCurrentMonth)
        : 0,
      hasSubscriptionsTable
        ? this.computeMRRFromChurnedThisMonth(startOfCurrentMonth)
        : 0,
      this.sumRefundsCents(),
      this.countFailedPayments(),
    ]);

    const totalActiveSubsChange = newActiveThisMonth - churnedThisMonth;
    const mrrChange = mrrFromNew - mrrFromChurned;
    const refundsTotal = Math.round(refundsTotalCents) / 100;

    return {
      totalActiveSubs,
      totalActiveSubsChange,
      mrr,
      mrrChange,
      refundsTotal,
      failedPaymentsCount,
    };
  }

  async listPaymentReconciliationIssues(options?: {
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, options?.page || 1);
    const limit = Math.min(100, Math.max(1, options?.limit || 20));
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000);

    const pr = ADMIN_PAYMENT_RECORD_ALIAS;
    const qb = this.dataSource
      .getRepository(PaymentRecord)
      .createQueryBuilder(pr)
      .where(`${pr}."deletedAt" IS NULL`)
      .andWhere(
        `(${pr}."refundStatus" = :refundFailed
          OR ${pr}."reversalStatus" = :reversalFailed
          OR (${pr}."refundStatus" = :refundRequested AND ${pr}."refundRequestedAt" <= :staleCutoff)
          OR (${pr}."refundStatus" = :refundSucceeded AND ${pr}."reversalStatus" IN (:...pendingReversalStates) AND ${pr}."reversalRequestedAt" <= :staleCutoff))`,
        {
          refundFailed: 'failed',
          reversalFailed: 'failed',
          refundRequested: 'requested',
          refundSucceeded: 'succeeded',
          pendingReversalStates: ['requested', 'pending_webhook'],
          staleCutoff,
        },
      )
      .orderBy(`COALESCE(${pr}."updatedAt", ${pr}."createdAt")`, 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [records, total] = await qb.getManyAndCount();
    const bookingIds = records.map((record) => record.bookingId);
    const bookings = bookingIds.length
      ? await this.dataSource
          .getRepository(Booking)
          .findBy({ id: In(bookingIds) })
      : [];
    const bookingMap = new Map(
      bookings.map((booking) => [booking.id, booking]),
    );

    const items = records
      .map((record) => this.buildReconciliationIssue(record, bookingMap))
      .filter((issue): issue is PaymentReconciliationIssue => !!issue);

    return {
      success: true,
      message: 'Payment reconciliation issues retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async listSettlementIssues(options?: { page?: number; limit?: number }) {
    const page = Math.max(1, options?.page || 1);
    const limit = Math.min(100, Math.max(1, options?.limit || 20));
    const now = new Date();

    const pr = ADMIN_PAYMENT_RECORD_ALIAS;
    const qb = this.dataSource
      .getRepository(PaymentRecord)
      .createQueryBuilder(pr)
      .where(`${pr}."deletedAt" IS NULL`)
      .andWhere(`${pr}."paymentModel" = :separate`, { separate: 'separate' })
      .andWhere(
        `(${pr}."settlementStatus" = :failed
          OR (${pr}."settlementStatus" = :eligible AND ${pr}."settlementEligibleAt" IS NOT NULL AND ${pr}."settlementEligibleAt" <= :now))`,
        { failed: 'failed', eligible: 'eligible', now },
      )
      .orderBy(`COALESCE(${pr}."updatedAt", ${pr}."createdAt")`, 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [records, total] = await qb.getManyAndCount();
    const bookingIds = records.map((record) => record.bookingId);
    const bookings = bookingIds.length
      ? await this.dataSource
          .getRepository(Booking)
          .findBy({ id: In(bookingIds) })
      : [];
    const bookingMap = new Map(
      bookings.map((booking) => [booking.id, booking]),
    );

    const items = records
      .map((record) => this.buildSettlementIssue(record, bookingMap, now))
      .filter((issue): issue is SettlementReconciliationIssue => !!issue);

    return {
      success: true,
      message: 'Settlement reconciliation issues retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async listFinancialReconciliationIssues(options?: {
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, options?.page || 1);
    const limit = Math.min(100, Math.max(1, options?.limit || 20));
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000);

    const pr = ADMIN_PAYMENT_RECORD_ALIAS;
    const qb = this.dataSource
      .getRepository(PaymentRecord)
      .createQueryBuilder(pr)
      .where(`${pr}."deletedAt" IS NULL`)
      .andWhere(
        `(${pr}."refundStatus" = :refundFailed
          OR ${pr}."reversalStatus" = :reversalFailed
          OR ${pr}."settlementStatus" = :settlementFailed
          OR (${pr}."refundStatus" = :refundRequested AND ${pr}."refundRequestedAt" <= :staleCutoff)
          OR (${pr}."refundStatus" = :refundSucceeded AND ${pr}."reversalStatus" IN (:...pendingReversalStates) AND ${pr}."reversalRequestedAt" <= :staleCutoff)
          OR (${pr}."refundMetaData"->'manualReview'->>'required') = 'true')`,
        {
          refundFailed: 'failed',
          reversalFailed: 'failed',
          settlementFailed: 'failed',
          refundRequested: 'requested',
          refundSucceeded: 'succeeded',
          pendingReversalStates: ['requested', 'pending_webhook'],
          staleCutoff,
        },
      )
      .orderBy(`COALESCE(${pr}."updatedAt", ${pr}."createdAt")`, 'DESC')
      .skip((page - 1) * limit)
      .take(limit * 3);

    const records = await qb.getMany();
    const bookingIds = records.map((record) => record.bookingId);
    const bookings = bookingIds.length
      ? await this.dataSource
          .getRepository(Booking)
          .findBy({ id: In(bookingIds) })
      : [];
    const bookingMap = new Map(
      bookings.map((booking) => [booking.id, booking]),
    );

    const allItems = records
      .map((record) =>
        this.buildFinancialReconciliationIssue(record, bookingMap),
      )
      .filter((issue): issue is FinancialReconciliationIssue => !!issue);

    const offset = (page - 1) * limit;
    const items = allItems.slice(offset, offset + limit);
    const total = allItems.length;

    return {
      success: true,
      message: 'Financial reconciliation issues retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  async retryBookingSettlement(bookingId: string) {
    const paymentRecord = await this.dataSource
      .getRepository(PaymentRecord)
      .findOne({ where: { bookingId } });
    if (!paymentRecord) {
      throw new NotFoundException('Payment record not found for booking');
    }

    const booking = await this.dataSource.getRepository(Booking).findOne({
      where: { id: bookingId },
    });
    const financialState = buildBookingFinancialState(paymentRecord, booking);
    if (financialState.recommendedAction !== 'retry_settlement') {
      throw new BadRequestException(
        'Booking does not currently require settlement retry',
      );
    }

    const result = await this.settlementService.retrySettlement(bookingId);
    if (!result.settled) {
      throw new BadRequestException(
        result.error || 'Settlement retry did not complete',
      );
    }
    return result;
  }

  async retryBookingRefund(bookingId: string) {
    const paymentRecord = await this.dataSource
      .getRepository(PaymentRecord)
      .findOne({
        where: { bookingId },
      });
    if (!paymentRecord) {
      throw new NotFoundException('Payment record not found for booking');
    }

    const issue = this.buildReconciliationIssue(paymentRecord);
    if (!issue) {
      throw new BadRequestException(
        'Booking does not currently require refund recovery',
      );
    }
    if (issue.recommendedAction !== 'retry_refund') {
      throw new BadRequestException(
        'This booking requires manual Stripe review and cannot be retried automatically',
      );
    }

    const lastAttempt = paymentRecord.refundMetaData?.lastAttempt;
    if (!lastAttempt) {
      throw new BadRequestException(
        'No prior refund attempt metadata found for retry',
      );
    }

    return this.refundOrchestrationService.processBookingRefund(bookingId, {
      amountCents: Number(lastAttempt.requestedAmountCents),
      reason: String(
        lastAttempt.reason || paymentRecord.refundReason || 'Admin retry',
      ),
      outcomeCode: String(lastAttempt.outcomeCode || 'admin_retry'),
      reverseTransfer: lastAttempt.reverseTransfer !== false,
      refundApplicationFee: lastAttempt.refundApplicationFee !== false,
    });
  }

  private async countActiveSubscriptions(): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    return this.dataSource
      .getRepository(Subscription)
      .createQueryBuilder(sub)
      .where(`${sub}.status = :status`, { status: SubscriptionStatus.ACTIVE })
      .andWhere(`${sub}."deletedAt" IS NULL`)
      .getCount();
  }

  private async countNewActiveSubscriptionsThisMonth(
    startOfMonth: Date,
  ): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    return this.dataSource
      .getRepository(Subscription)
      .createQueryBuilder(sub)
      .where(`${sub}.status = :status`, { status: SubscriptionStatus.ACTIVE })
      .andWhere(`${sub}."createdAt" >= :start`, { start: startOfMonth })
      .andWhere(`${sub}."deletedAt" IS NULL`)
      .getCount();
  }

  private async countChurnedSubscriptionsThisMonth(
    startOfMonth: Date,
  ): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    return this.dataSource
      .getRepository(Subscription)
      .createQueryBuilder(sub)
      .where(`${sub}.status IN (:...statuses)`, {
        statuses: [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED],
      })
      .andWhere(`${sub}."updatedAt" >= :start`, { start: startOfMonth })
      .andWhere(`${sub}."deletedAt" IS NULL`)
      .getCount();
  }

  /** Aggregate MRR in SQL (plan × count) instead of loading every subscription row. */
  private async sumMrrByPlanFilter(
    extraWhere: string,
    params: Record<string, unknown>,
  ): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    const rows = await this.dataSource
      .getRepository(Subscription)
      .createQueryBuilder(sub)
      .select(`${sub}.plan`, 'plan')
      .addSelect(`COUNT(${sub}.id)::int`, 'cnt')
      .where(`${sub}."deletedAt" IS NULL`)
      .andWhere(extraWhere, params)
      .groupBy(`${sub}.plan`)
      .getRawMany<{ plan: SubscriptionPlan; cnt: string }>();

    return rows.reduce(
      (sum, row) =>
        sum + (PLAN_MONTHLY_PRICE[row.plan] ?? 0) * Number(row.cnt ?? 0),
      0,
    );
  }

  private async computeMRR(): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    return this.sumMrrByPlanFilter(`${sub}.status = :status`, {
      status: SubscriptionStatus.ACTIVE,
    });
  }

  private async computeMRRFromNewActiveThisMonth(
    startOfMonth: Date,
  ): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    return this.sumMrrByPlanFilter(
      `${sub}.status = :status AND ${sub}."createdAt" >= :start`,
      { status: SubscriptionStatus.ACTIVE, start: startOfMonth },
    );
  }

  private async computeMRRFromChurnedThisMonth(
    startOfMonth: Date,
  ): Promise<number> {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    return this.sumMrrByPlanFilter(
      `${sub}.status IN (:...statuses) AND ${sub}."updatedAt" >= :start`,
      {
        statuses: [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED],
        start: startOfMonth,
      },
    );
  }

  private async sumRefundsCents(): Promise<number> {
    const pr = ADMIN_PAYMENT_RECORD_ALIAS;
    const result = await this.dataSource
      .getRepository(PaymentRecord)
      .createQueryBuilder(pr)
      .select(`COALESCE(SUM(${pr}."refundAmountCents"), 0)`, 'total')
      .where(`${pr}."refundedAt" IS NOT NULL`)
      .andWhere(`${pr}."deletedAt" IS NULL`)
      .getRawOne<{ total: string }>();

    return Number(result?.total ?? 0);
  }

  private async countFailedPayments(): Promise<number> {
    const pr = ADMIN_PAYMENT_RECORD_ALIAS;
    return this.dataSource
      .getRepository(PaymentRecord)
      .createQueryBuilder(pr)
      .where(`${pr}.status = :status`, { status: PaymentRecordStatus.FAILED })
      .andWhere(`${pr}."deletedAt" IS NULL`)
      .getCount();
  }

  private buildSettlementIssue(
    record: PaymentRecord,
    bookingMap?: Map<string, Booking>,
    now: Date = new Date(),
  ): SettlementReconciliationIssue | null {
    if (record.paymentModel !== 'separate') {
      return null;
    }

    let issueCode: SettlementReconciliationIssue['issueCode'] | null = null;
    let recommendedAction: SettlementReconciliationIssue['recommendedAction'] =
      'manual_stripe_review';

    if (record.settlementStatus === 'failed') {
      issueCode = 'settlement_failed';
      recommendedAction = 'retry_settlement';
    } else if (
      record.settlementStatus === 'eligible' &&
      record.settlementEligibleAt &&
      record.settlementEligibleAt <= now
    ) {
      issueCode = 'settlement_overdue';
      recommendedAction = 'retry_settlement';
    }

    if (!issueCode) {
      return null;
    }

    return {
      bookingId: record.bookingId,
      paymentRecordId: record.id,
      bookingStatus: bookingMap?.get(record.bookingId)?.status || null,
      paymentModel: record.paymentModel || null,
      settlementStatus: record.settlementStatus || null,
      settlementEligibleAt: record.settlementEligibleAt || null,
      issueCode,
      recommendedAction,
      lastUpdatedAt: record.updatedAt,
    };
  }

  private buildFinancialReconciliationIssue(
    record: PaymentRecord,
    bookingMap?: Map<string, Booking>,
  ): FinancialReconciliationIssue | null {
    const booking = bookingMap?.get(record.bookingId);
    const financialState = buildBookingFinancialState(record, booking);

    if (
      !financialState.issueCode &&
      !financialState.needsManualReview &&
      !financialState.recommendedAction
    ) {
      return null;
    }

    return {
      bookingId: record.bookingId,
      paymentRecordId: record.id,
      bookingStatus: booking?.status || null,
      paymentModel: financialState.paymentModel,
      settlementStatus: financialState.settlementStatus,
      issueCode: financialState.issueCode,
      issueMessage: financialState.issueMessage,
      recommendedAction: financialState.recommendedAction,
      needsManualReview: financialState.needsManualReview,
      financialState,
      lastUpdatedAt: record.updatedAt,
    };
  }

  private buildReconciliationIssue(
    record: PaymentRecord,
    bookingMap?: Map<string, Booking>,
  ): PaymentReconciliationIssue | null {
    let issueCode: PaymentReconciliationIssue['issueCode'] | null = null;
    let recommendedAction: PaymentReconciliationIssue['recommendedAction'] =
      'manual_stripe_review';

    if (record.refundStatus === 'failed') {
      issueCode = 'refund_failed';
      recommendedAction = 'retry_refund';
    } else if (record.reversalStatus === 'failed') {
      issueCode = 'reversal_failed';
    } else if (record.refundStatus === 'requested') {
      issueCode = 'refund_stuck';
      recommendedAction = 'retry_refund';
    } else if (
      record.refundStatus === 'succeeded' &&
      ['requested', 'pending_webhook'].includes(record.reversalStatus || '')
    ) {
      issueCode = 'reversal_stuck';
    }

    if (!issueCode) {
      return null;
    }

    return {
      bookingId: record.bookingId,
      paymentRecordId: record.id,
      bookingStatus: bookingMap?.get(record.bookingId)?.status || null,
      paymentStatus: record.status,
      refundStatus: record.refundStatus || null,
      reversalStatus: record.reversalStatus || null,
      refundFailureReason: record.refundFailureReason || null,
      reversalFailureReason: record.reversalFailureReason || null,
      issueCode,
      recommendedAction,
      requestedAt:
        record.refundRequestedAt || record.reversalRequestedAt || null,
      lastUpdatedAt: record.updatedAt,
    };
  }
}
