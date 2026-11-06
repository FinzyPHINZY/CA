/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Booking,
  BookingStatus,
  PaymentRecord,
  PaymentRecordStatus,
  ReaderProfile,
  RedisLockService,
} from '@app/common';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ConnectPaymentService } from './connect-payment.service';
import { FeeCalculationService } from './fee-calculation.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function mockQueryBuilder(result: any = [], count: number = 0) {
  return {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(result),
    getManyAndCount: jest.fn().mockResolvedValue([result, count]),
    getRawOne: jest.fn().mockResolvedValue(result),
  };
}

describe('ConnectPaymentService', () => {
  let service: ConnectPaymentService;

  let bookingRepo: ReturnType<typeof mockRepository>;
  let profileRepo: ReturnType<typeof mockRepository>;
  let paymentRecordRepo: ReturnType<typeof mockRepository>;
  let mockRedisLockService: jest.Mocked<Partial<RedisLockService>>;
  const bookingId = 'booking-1';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    bookingRepo = mockRepository();
    profileRepo = mockRepository();
    paymentRecordRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[Booking.name] = bookingRepo;
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[PaymentRecord.name] = paymentRecordRepo;

    const mockManager = {
      getRepository: jest.fn((entity) => repoMap[entity.name]),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    const mockConfigService = {
      get: jest.fn().mockReturnValue(null), // no Stripe key = Stripe not configured
    } as unknown as ConfigService;

    mockRedisLockService = {
      get: jest.fn().mockResolvedValue(null),
      setWithTTL: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<Partial<RedisLockService>>;

    const feeService = new FeeCalculationService();

    const mockNotificationsClient = {
      emit: jest.fn(),
    };

    service = new ConnectPaymentService(
      mockConfigService,
      mockDataSource,
      feeService,
      mockRedisLockService as unknown as RedisLockService,
      mockNotificationsClient as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── createConnectedPaymentIntent ───────────────────────────────────

  describe('createConnectedPaymentIntent', () => {
    it('should throw if Stripe is not configured', async () => {
      await expect(
        service.createConnectedPaymentIntent(bookingId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if booking not found', async () => {
      // Manually set stripe to bypass the "not configured" check
      (service as any).stripe = { paymentIntents: { create: jest.fn() } };
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createConnectedPaymentIntent(bookingId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw if booking not in HELD status', async () => {
      (service as any).stripe = { paymentIntents: { create: jest.fn() } };
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.CONFIRMED,
      });

      await expect(
        service.createConnectedPaymentIntent(bookingId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if reader has no Stripe account', async () => {
      (service as any).stripe = { paymentIntents: { create: jest.fn() } };
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.HELD,
        readerProfileId: 'profile-1',
        priceCents: 5000,
        currency: 'USD',
      });
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        stripeAccountId: null,
      });

      await expect(
        service.createConnectedPaymentIntent(bookingId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create PaymentIntent with correct fees and save PaymentRecord', async () => {
      const mockPI = {
        id: 'pi_test_123',
        client_secret: 'cs_test_secret',
      };

      (service as any).stripe = {
        paymentIntents: {
          create: jest.fn().mockResolvedValue(mockPI),
        },
      };

      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.HELD,
        readerProfileId: 'profile-1',
        priceCents: 10000,
        currency: 'USD',
        actorUserId: 'actor-1',
        readerUserId: 'reader-1',
      });
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        stripeAccountId: 'acct_reader_1',
      });

      const result = await service.createConnectedPaymentIntent(bookingId);

      expect(result.data.clientSecret).toBe('cs_test_secret');
      expect(result.data.paymentIntentId).toBe('pi_test_123');

      // Verify Stripe was called with correct params
      const stripeCall = (service as any).stripe.paymentIntents.create.mock
        .calls[0][0];
      expect(stripeCall.amount).toBe(10000);
      expect(stripeCall.application_fee_amount).toBe(1500); // 15%
      expect(stripeCall.transfer_data.destination).toBe('acct_reader_1');

      // Verify PaymentRecord was created
      expect(paymentRecordRepo.save).toHaveBeenCalled();
      const savedRecord = paymentRecordRepo.create.mock.calls[0][0];
      expect(savedRecord.status).toBe(PaymentRecordStatus.PENDING);
      expect(savedRecord.amountCents).toBe(10000);
      expect(savedRecord.platformFeeCents).toBe(1500);
      expect(savedRecord.readerPayoutCents).toBe(8500);
    });
  });

  describe('createConnectedPaymentIntent (separate charges)', () => {
    it('should omit transfer_data and application_fee for separate charges', async () => {
      const mockPI = {
        id: 'pi_separate_1',
        client_secret: 'cs_separate_secret',
      };

      (service as any).stripe = {
        paymentIntents: {
          create: jest.fn().mockResolvedValue(mockPI),
        },
      };

      // Override configService to return 'separate'
      const configGet = (service as any).configService.get;
      configGet.mockImplementation((key: string) => {
        if (key === 'PAYMENT_MODEL') return 'separate';
        return null;
      });

      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.HELD,
        readerProfileId: 'profile-1',
        priceCents: 10000,
        currency: 'USD',
        actorUserId: 'actor-1',
        readerUserId: 'reader-1',
      });
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        stripeAccountId: 'acct_reader_1',
      });

      const result = await service.createConnectedPaymentIntent(bookingId);

      expect(result.data.paymentIntentId).toBe('pi_separate_1');

      // Verify Stripe params do NOT include transfer_data or application_fee
      const stripeCall = (service as any).stripe.paymentIntents.create.mock
        .calls[0][0];
      expect(stripeCall.amount).toBe(10000);
      expect(stripeCall.transfer_data).toBeUndefined();
      expect(stripeCall.application_fee_amount).toBeUndefined();
      expect(stripeCall.metadata.readerStripeAccountId).toBe('acct_reader_1');

      // Verify PaymentRecord has separate model
      const savedRecord = paymentRecordRepo.create.mock.calls[0][0];
      expect(savedRecord.paymentModel).toBe('separate');
      expect(savedRecord.settlementStatus).toBe('pending');
    });
  });

  // ─── handlePaymentIntentSucceeded ───────────────────────────────────

  describe('handlePaymentIntentSucceeded', () => {
    it('should mark PaymentRecord as SUCCEEDED without confirming the booking', async () => {
      const record = {
        stripePaymentIntentId: 'pi_123',
        status: PaymentRecordStatus.PENDING,
      };

      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handlePaymentIntentSucceeded({
        id: 'pi_123',
        metadata: { bookingId },
      } as any);

      expect(bookingRepo.save).not.toHaveBeenCalled();
      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentRecordStatus.SUCCEEDED }),
      );
    });

    it('should do nothing if no bookingId in metadata', async () => {
      await service.handlePaymentIntentSucceeded({
        id: 'pi_123',
        metadata: {},
      } as any);

      expect(bookingRepo.findOne).not.toHaveBeenCalled();
    });

    it('should do nothing if no payment record matches the PaymentIntent', async () => {
      paymentRecordRepo.findOne.mockResolvedValue(null);
      await service.handlePaymentIntentSucceeded({
        id: 'pi_123',
        metadata: { bookingId },
      } as any);

      expect(bookingRepo.save).not.toHaveBeenCalled();
      expect(paymentRecordRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── handlePaymentIntentFailed ──────────────────────────────────────

  describe('handlePaymentIntentFailed', () => {
    it('should mark PaymentRecord as FAILED', async () => {
      const record = {
        stripePaymentIntentId: 'pi_123',
        status: PaymentRecordStatus.PENDING,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handlePaymentIntentFailed({
        id: 'pi_123',
        metadata: { bookingId },
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentRecordStatus.FAILED }),
      );
    });

    it('should do nothing if no bookingId in metadata', async () => {
      await service.handlePaymentIntentFailed({
        id: 'pi_123',
        metadata: {},
      } as any);

      expect(paymentRecordRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ─── handleTransferCreated ──────────────────────────────────────────

  describe('handleTransferCreated', () => {
    it('should store transfer ID on PaymentRecord', async () => {
      const record = { bookingId, stripeTransferId: null };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handleTransferCreated({
        id: 'tr_123',
        metadata: { bookingId },
        source_transaction: 'ch_123',
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ stripeTransferId: 'tr_123' }),
      );
    });
  });

  describe('handleTransferCreated (separate charges)', () => {
    it('should confirm settlement for separate-charge records', async () => {
      const record = {
        bookingId,
        stripeTransferId: null,
        paymentModel: 'separate',
        settlementStatus: 'eligible',
        settledAt: null,
        status: PaymentRecordStatus.SUCCEEDED,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handleTransferCreated({
        id: 'tr_settled_1',
        metadata: { bookingId },
        source_transaction: null,
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeTransferId: 'tr_settled_1',
          settlementStatus: 'settled',
          status: PaymentRecordStatus.SETTLED,
        }),
      );
    });
  });

  describe('handleTransferFailed', () => {
    it('should mark separate-charge settlement as failed', async () => {
      const record = {
        bookingId,
        paymentModel: 'separate',
        settlementStatus: 'eligible',
        settlementMetaData: null,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handleTransferFailed({
        id: 'tr_failed_1',
        metadata: { bookingId },
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementStatus: 'failed',
          settlementMetaData: expect.objectContaining({
            lastFailureReason: 'Transfer failed (Stripe webhook)',
          }),
        }),
      );
    });
  });

  // ─── handleTransferReversed ─────────────────────────────────────────

  describe('handleTransferReversed', () => {
    it('should mark record as REFUNDED', async () => {
      const record = {
        stripeTransferId: 'tr_123',
        status: PaymentRecordStatus.SUCCEEDED,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handleTransferReversed({
        id: 'tr_123',
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PaymentRecordStatus.REFUNDED,
          refundReason: 'Transfer reversed',
        }),
      );
    });
  });

  describe('handleRefundUpdated', () => {
    it('should reconcile a successful full refund into PaymentRecord', async () => {
      const record = {
        id: 'pr_1',
        bookingId,
        stripePaymentIntentId: 'pi_123',
        amountCents: 10000,
        status: PaymentRecordStatus.SUCCEEDED,
      };
      paymentRecordRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(record);

      await service.handleRefundUpdated({
        id: 'rf_123',
        amount: 10000,
        created: 1_700_000_000,
        failure_reason: null,
        payment_intent: 'pi_123',
        reason: 'requested_by_customer',
        status: 'succeeded',
        transfer_reversal: 'trr_123',
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeRefundId: 'rf_123',
          stripeTransferReversalId: 'trr_123',
          refundStatus: 'succeeded',
          reversalStatus: 'pending_webhook',
          status: PaymentRecordStatus.REFUNDED,
        }),
      );
    });

    it('should reconcile a failed refund back to SUCCEEDED payment status', async () => {
      const record = {
        id: 'pr_2',
        bookingId,
        stripePaymentIntentId: 'pi_123',
        amountCents: 10000,
        status: PaymentRecordStatus.REFUNDED,
        reversalStatus: 'pending_webhook',
      };
      paymentRecordRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(record);

      await service.handleRefundUpdated({
        id: 'rf_456',
        amount: 10000,
        created: 1_700_000_000,
        failure_reason: 'declined',
        payment_intent: 'pi_123',
        reason: 'requested_by_customer',
        status: 'failed',
        transfer_reversal: 'trr_456',
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeRefundId: 'rf_456',
          refundStatus: 'failed',
          refundFailureReason: 'declined',
          reversalStatus: 'failed',
          reversalFailureReason: 'declined',
          status: PaymentRecordStatus.SUCCEEDED,
        }),
      );
    });
  });

  describe('handleChargeRefunded', () => {
    it('should reconcile charge refund details into PaymentRecord', async () => {
      const record = {
        id: 'pr_1',
        bookingId,
        stripePaymentIntentId: 'pi_123',
        amountCents: 10000,
        status: PaymentRecordStatus.SUCCEEDED,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.handleChargeRefunded({
        id: 'ch_123',
        amount_refunded: 10000,
        created: 1_700_000_000,
        payment_intent: 'pi_123',
        refunds: {
          data: [
            {
              id: 're_123',
              status: 'succeeded',
              failure_reason: null,
              transfer_reversal: 'trr_123',
            },
          ],
        },
      } as any);

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeRefundId: 're_123',
          stripeTransferReversalId: 'trr_123',
          refundStatus: 'succeeded',
          status: PaymentRecordStatus.REFUNDED,
        }),
      );
    });
  });

  // ─── refundPaymentIntent ────────────────────────────────────────────

  describe('refundPaymentIntent', () => {
    it('should throw if Stripe not configured', async () => {
      await expect(service.refundPaymentIntent('pi_123')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should create full refund and update PaymentRecord', async () => {
      const mockRefund = { id: 'rf_123' };
      (service as any).stripe = {
        refunds: { create: jest.fn().mockResolvedValue(mockRefund) },
      };

      const record = {
        stripePaymentIntentId: 'pi_123',
        amountCents: 10000,
        status: PaymentRecordStatus.SUCCEEDED,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      const result = await service.refundPaymentIntent('pi_123');

      expect(result.id).toBe('rf_123');
      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PaymentRecordStatus.REFUNDED,
          refundAmountCents: 10000, // full
        }),
      );
    });

    it('should create partial refund and mark as PARTIALLY_REFUNDED', async () => {
      const mockRefund = { id: 'rf_456' };
      (service as any).stripe = {
        refunds: { create: jest.fn().mockResolvedValue(mockRefund) },
      };

      const record = {
        stripePaymentIntentId: 'pi_123',
        amountCents: 10000,
        status: PaymentRecordStatus.SUCCEEDED,
      };
      paymentRecordRepo.findOne.mockResolvedValue(record);

      await service.refundPaymentIntent('pi_123', {
        amountCents: 5000,
        reason: '50% cancellation',
      });

      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PaymentRecordStatus.PARTIALLY_REFUNDED,
          refundAmountCents: 5000,
          refundReason: '50% cancellation',
        }),
      );
    });
  });

  describe('refundPaymentIntent (separate charges)', () => {
    it('should skip reverse_transfer and refund_application_fee for separate charges', async () => {
      const mockRefund = { id: 'rf_sep_1' };
      (service as any).stripe = {
        refunds: { create: jest.fn().mockResolvedValue(mockRefund) },
      };

      const record = {
        stripePaymentIntentId: 'pi_123',
        amountCents: 10000,
        status: PaymentRecordStatus.SUCCEEDED,
        paymentModel: 'separate',
        settlementStatus: 'pending',
      };
      // First findOne: check paymentModel. Second findOne: update after refund.
      paymentRecordRepo.findOne
        .mockResolvedValueOnce(record)
        .mockResolvedValueOnce({ ...record });

      await service.refundPaymentIntent('pi_123', {
        amountCents: 10000,
        reverseTransfer: true, // caller passes true but should be ignored
        refundApplicationFee: true, // should be ignored
      });

      // Verify Stripe refund params do NOT include reverse_transfer or refund_application_fee
      const stripeCall = (service as any).stripe.refunds.create.mock
        .calls[0][0];
      expect(stripeCall.reverse_transfer).toBeUndefined();
      expect(stripeCall.refund_application_fee).toBeUndefined();

      // Verify settlementStatus set to 'skipped'
      expect(paymentRecordRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementStatus: 'skipped',
          reversalStatus: 'not_required',
        }),
      );
    });
  });

  // ─── getPaymentHistory ──────────────────────────────────────────────

  describe('getPaymentHistory', () => {
    it('should filter by actor role', async () => {
      const qb = mockQueryBuilder([{ id: 'pr-1' }], 1);
      paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getPaymentHistory('user-1', {
        role: 'actor',
      });

      expect(qb.where).toHaveBeenCalledWith('pr.actorUserId = :userId', {
        userId: 'user-1',
      });
      expect(result.data.items).toHaveLength(1);
    });

    it('should filter by reader role', async () => {
      const qb = mockQueryBuilder([], 0);
      paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getPaymentHistory('user-1', { role: 'reader' });

      expect(qb.where).toHaveBeenCalledWith('pr.readerUserId = :userId', {
        userId: 'user-1',
      });
    });

    it('should filter by both roles when none specified', async () => {
      const qb = mockQueryBuilder([], 0);
      paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getPaymentHistory('user-1');

      expect(qb.where).toHaveBeenCalledWith(
        '(pr.actorUserId = :userId OR pr.readerUserId = :userId)',
        { userId: 'user-1' },
      );
    });

    it('should return pagination metadata', async () => {
      const qb = mockQueryBuilder([{ id: 'pr-1' }], 50);
      paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getPaymentHistory('user-1', {
        page: 2,
        limit: 10,
      });

      expect(result.data.total).toBe(50);
      expect(result.data.totalPages).toBe(5);
      expect(result.data.page).toBe(2);
      expect(result.data.hasNext).toBe(true);
      expect(result.data.hasPrev).toBe(true);
    });
  });

  // ─── getReaderEarnings ──────────────────────────────────────────────

  describe('getReaderEarnings', () => {
    it('should return aggregated earnings data', async () => {
      const qb = mockQueryBuilder({
        totalEarnedCents: '85000',
        pendingPayoutCents: '4250',
        totalPlatformFeesCents: '15000',
        completedPayments: '10',
        totalRefundedCents: '5000',
      });
      paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getReaderEarnings('reader-1');

      expect(result.data.totalEarnedCents).toBe(85000);
      expect(result.data.pendingPayoutCents).toBe(4250);
      expect(result.data.totalPlatformFeesCents).toBe(15000);
      expect(result.data.completedPayments).toBe(10);
      expect(result.data.totalRefundedCents).toBe(5000);
      expect(result.data.currency).toBe('USD');
    });

    it('should return zeros when no payment records exist', async () => {
      const qb = mockQueryBuilder(null);
      paymentRecordRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getReaderEarnings('new-reader');

      expect(result.data.totalEarnedCents).toBe(0);
      expect(result.data.pendingPayoutCents).toBe(0);
      expect(result.data.completedPayments).toBe(0);
    });
  });
});
