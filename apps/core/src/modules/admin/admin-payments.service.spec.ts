/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  Booking,
  BookingStatus,
  PaymentRecord,
  PaymentRecordStatus,
} from '@app/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RefundOrchestrationService } from '../marketplace/booking/refund-orchestration.service';
import { SettlementService } from '../marketplace/booking/settlement.service';
import { AdminPaymentsService } from './admin-payments.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    findBy: jest.fn(),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function mockQueryBuilder(result: any[] = [], count = 0) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([result, count]),
  };
}

describe('AdminPaymentsService', () => {
  let service: AdminPaymentsService;
  let paymentRecordRepo: ReturnType<typeof mockRepository>;
  let bookingRepo: ReturnType<typeof mockRepository>;
  let refundOrchestrationService: jest.Mocked<
    Partial<RefundOrchestrationService>
  >;
  let settlementService: jest.Mocked<Partial<SettlementService>>;

  beforeEach(() => {
    paymentRecordRepo = mockRepository();
    bookingRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {
      [PaymentRecord.name]: paymentRecordRepo,
      [Booking.name]: bookingRepo,
    };

    const dataSource = {
      query: jest.fn().mockResolvedValue([{ exists: true }]),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    settlementService = {
      retrySettlement: jest.fn().mockResolvedValue({ settled: true }),
    };

    refundOrchestrationService = {
      processBookingRefund: jest.fn().mockResolvedValue({
        action: 'refunded',
        booking: { id: 'booking-1' },
        paymentRecord: null,
        refundId: 're_123',
        transferReversalId: 'trr_123',
        refundStatus: 'succeeded',
        reversalStatus: 'pending_webhook',
        reason: 'Admin retry',
      }),
    };

    service = new AdminPaymentsService(
      dataSource,
      refundOrchestrationService as unknown as RefundOrchestrationService,
      settlementService as unknown as SettlementService,
    );
  });

  it('returns payments summary with zeroed subscription metrics when subscriptions table is missing', async () => {
    const ds = (service as any).dataSource as {
      query: jest.Mock;
      getRepository: jest.Mock;
    };
    ds.query.mockResolvedValue([{ exists: false }]);

    const sumRefundsQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ total: '12345' }),
    };
    const failedCountQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(2),
    };

    paymentRecordRepo.createQueryBuilder
      .mockReturnValueOnce(sumRefundsQb as any)
      .mockReturnValueOnce(failedCountQb as any);

    const summary = await service.getPaymentsSummary();

    expect(summary).toEqual({
      totalActiveSubs: 0,
      totalActiveSubsChange: 0,
      mrr: 0,
      mrrChange: 0,
      refundsTotal: 123.45,
      failedPaymentsCount: 2,
    });
  });

  it('lists refund reconciliation issues', async () => {
    const qb = mockQueryBuilder(
      [
        {
          id: 'pr_1',
          bookingId: 'booking-1',
          status: PaymentRecordStatus.SUCCEEDED,
          refundStatus: 'failed',
          reversalStatus: 'not_started',
          refundFailureReason: 'declined',
          reversalFailureReason: null,
          refundRequestedAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      1,
    );
    paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);
    bookingRepo.findBy.mockResolvedValue([
      { id: 'booking-1', status: BookingStatus.CANCELLED } as Booking,
    ]);

    const result = await service.listPaymentReconciliationIssues();

    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({
      bookingId: 'booking-1',
      issueCode: 'refund_failed',
      recommendedAction: 'retry_refund',
      bookingStatus: BookingStatus.CANCELLED,
    });
  });

  it('retries refund only for retryable issues', async () => {
    paymentRecordRepo.findOne.mockResolvedValue({
      id: 'pr_1',
      bookingId: 'booking-1',
      status: PaymentRecordStatus.SUCCEEDED,
      refundStatus: 'failed',
      reversalStatus: 'not_started',
      refundReason: 'Reader cancelled — full refund',
      refundMetaData: {
        lastAttempt: {
          requestedAmountCents: 10000,
          reason: 'Reader cancelled — full refund',
          outcomeCode: 'reader_cancel',
          reverseTransfer: true,
          refundApplicationFee: true,
        },
      },
    } as unknown as PaymentRecord);

    await service.retryBookingRefund('booking-1');

    expect(
      refundOrchestrationService.processBookingRefund,
    ).toHaveBeenCalledWith(
      'booking-1',
      expect.objectContaining({
        amountCents: 10000,
        outcomeCode: 'reader_cancel',
      }),
    );
  });

  it('does not retry refund again once the issue is no longer retryable', async () => {
    const mutablePaymentRecord: any = {
      id: 'pr_1',
      bookingId: 'booking-1',
      status: PaymentRecordStatus.SUCCEEDED,
      refundStatus: 'failed',
      reversalStatus: 'not_started',
      refundReason: 'Reader cancelled — full refund',
      refundMetaData: {
        lastAttempt: {
          requestedAmountCents: 10000,
          reason: 'Reader cancelled — full refund',
          outcomeCode: 'reader_cancel',
          reverseTransfer: true,
          refundApplicationFee: true,
        },
      },
    } as unknown as PaymentRecord;
    paymentRecordRepo.findOne.mockImplementation(
      async () => mutablePaymentRecord,
    );
    refundOrchestrationService.processBookingRefund.mockImplementation(
      (async () => {
        mutablePaymentRecord.refundStatus = 'succeeded';
        mutablePaymentRecord.status = PaymentRecordStatus.REFUNDED;
        return {
          action: 'refunded' as const,
          booking: { id: 'booking-1' } as any,
          paymentRecord: mutablePaymentRecord,
          refundId: 're_123',
          transferReversalId: 'trr_123',
          refundStatus: 'succeeded',
          reversalStatus: 'pending_webhook',
          reason: 'Admin retry',
        };
      }) as any,
    );

    await service.retryBookingRefund('booking-1');

    await expect(
      service.retryBookingRefund('booking-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      refundOrchestrationService.processBookingRefund,
    ).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundException when payment record is missing', async () => {
    paymentRecordRepo.findOne.mockResolvedValue(null);

    await expect(
      service.retryBookingRefund('missing-booking'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException when retry metadata is missing', async () => {
    paymentRecordRepo.findOne.mockResolvedValue({
      id: 'pr_1',
      bookingId: 'booking-1',
      status: PaymentRecordStatus.SUCCEEDED,
      refundStatus: 'failed',
      reversalStatus: 'not_started',
      refundMetaData: null,
    } as unknown as PaymentRecord);

    await expect(
      service.retryBookingRefund('booking-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
