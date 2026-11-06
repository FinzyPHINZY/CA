/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  Booking,
  BookingStatus,
  PaymentRecord,
  PaymentRecordStatus,
  RedisLockService,
} from '@app/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { SettlementService } from './settlement.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    save: jest.fn((entity) => Promise.resolve(entity)),
    ...overrides,
  };
}

describe('SettlementService', () => {
  let service: SettlementService;
  let paymentRepo: ReturnType<typeof mockRepository>;
  let bookingRepo: ReturnType<typeof mockRepository>;
  let mockRedisLockService: jest.Mocked<Partial<RedisLockService>>;
  let mockStripe: any;

  const bookingId = 'booking-1';

  const baseSeparatePayment = {
    id: 'pr_1',
    bookingId,
    stripePaymentIntentId: 'pi_123',
    amountCents: 10000,
    platformFeeCents: 1500,
    readerPayoutCents: 8500,
    currency: 'usd',
    status: PaymentRecordStatus.SUCCEEDED,
    paymentModel: 'separate',
    settlementStatus: 'eligible',
    stripeTransferId: null,
    settledAt: null,
    settlementMetaData: null,
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    paymentRepo = mockRepository();
    bookingRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {
      [PaymentRecord.name]: paymentRepo,
      [Booking.name]: bookingRepo,
    };

    const mockDataSource = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    mockRedisLockService = {
      acquireLock: jest
        .fn()
        .mockResolvedValue({ acquired: true, lockToken: 'tok_1' }),
      releaseLock: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<Partial<RedisLockService>>;

    const mockConfigService = {
      get: jest.fn().mockReturnValue('sk_test_key'),
    } as unknown as ConfigService;

    service = new SettlementService(
      mockConfigService,
      mockDataSource,
      mockRedisLockService as unknown as RedisLockService,
    );

    // Mock Stripe
    mockStripe = {
      transfers: {
        create: jest.fn().mockResolvedValue({ id: 'tr_settled_1' }),
      },
      paymentIntents: {
        retrieve: jest.fn().mockResolvedValue({
          metadata: { readerStripeAccountId: 'acct_reader_1' },
        }),
      },
    };
    (service as any).stripe = mockStripe;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── settleBooking ────────────────────────────────────────────────

  describe('settleBooking', () => {
    it('should create a transfer and update payment record + booking', async () => {
      paymentRepo.findOne.mockResolvedValue({ ...baseSeparatePayment });
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.AWAITING_SETTLEMENT,
      });

      const result = await service.settleBooking(bookingId);

      expect(result.settled).toBe(true);
      expect(result.transferId).toBe('tr_settled_1');

      // Verify Stripe transfer was called correctly
      expect(mockStripe.transfers.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 8500,
          currency: 'usd',
          destination: 'acct_reader_1',
          metadata: expect.objectContaining({
            bookingId,
            paymentIntentId: 'pi_123',
          }),
        }),
        expect.objectContaining({ idempotencyKey: `settlement_${bookingId}` }),
      );

      // Verify payment record updated
      expect(paymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeTransferId: 'tr_settled_1',
          settlementStatus: 'settled',
          status: PaymentRecordStatus.SETTLED,
        }),
      );

      // Verify booking transitioned to COMPLETED
      expect(bookingRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: BookingStatus.COMPLETED,
        }),
      );
    });

    it('should return early if already settled (idempotent)', async () => {
      paymentRepo.findOne.mockResolvedValue({
        ...baseSeparatePayment,
        settlementStatus: 'settled',
        stripeTransferId: 'tr_existing',
      });

      const result = await service.settleBooking(bookingId);

      expect(result.settled).toBe(true);
      expect(result.transferId).toBe('tr_existing');
      expect(mockStripe.transfers.create).not.toHaveBeenCalled();
    });

    it('should reject non-separate-charge payments', async () => {
      paymentRepo.findOne.mockResolvedValue({
        ...baseSeparatePayment,
        paymentModel: 'destination',
      });

      const result = await service.settleBooking(bookingId);

      expect(result.settled).toBe(false);
      expect(result.error).toBe('Not a separate-charge payment');
    });

    it('should reject non-eligible settlement status', async () => {
      paymentRepo.findOne.mockResolvedValue({
        ...baseSeparatePayment,
        settlementStatus: 'pending',
      });

      const result = await service.settleBooking(bookingId);

      expect(result.settled).toBe(false);
      expect(result.error).toContain('Invalid settlement status');
    });

    it('should mark as failed when Stripe transfer fails', async () => {
      paymentRepo.findOne.mockResolvedValue({ ...baseSeparatePayment });
      mockStripe.transfers.create.mockRejectedValue(
        new Error('Insufficient funds in Stripe account'),
      );

      const result = await service.settleBooking(bookingId);

      expect(result.settled).toBe(false);
      expect(result.error).toBe('Insufficient funds in Stripe account');
      expect(paymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementStatus: 'failed',
          settlementMetaData: expect.objectContaining({
            lastFailureReason: 'Insufficient funds in Stripe account',
          }),
        }),
      );
    });

    it('should return error when lock cannot be acquired', async () => {
      mockRedisLockService.acquireLock.mockResolvedValue({
        acquired: false,
        lockToken: null,
      } as any);

      const result = await service.settleBooking(bookingId);

      expect(result.settled).toBe(false);
      expect(result.error).toBe('Could not acquire lock');
    });

    it('should always release lock even on failure', async () => {
      paymentRepo.findOne.mockResolvedValue({ ...baseSeparatePayment });
      mockStripe.transfers.create.mockRejectedValue(new Error('boom'));

      await service.settleBooking(bookingId);

      expect(mockRedisLockService.releaseLock).toHaveBeenCalledWith(
        `settlement:${bookingId}`,
        'tok_1',
      );
    });
  });

  // ─── retrySettlement ──────────────────────────────────────────────

  describe('retrySettlement', () => {
    it('should reset to eligible and re-settle', async () => {
      const failedPayment = {
        ...baseSeparatePayment,
        settlementStatus: 'failed',
        settlementMetaData: { retryCount: 1 },
      };

      // First call: retrySettlement looks up the record
      // Second call: settleBooking looks up the record (now eligible)
      paymentRepo.findOne
        .mockResolvedValueOnce(failedPayment)
        .mockResolvedValueOnce({
          ...failedPayment,
          settlementStatus: 'eligible',
        });
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.AWAITING_SETTLEMENT,
      });

      const result = await service.retrySettlement(bookingId);

      expect(result.settled).toBe(true);
    });

    it('should return error if no failed settlement exists', async () => {
      paymentRepo.findOne.mockResolvedValue({
        ...baseSeparatePayment,
        settlementStatus: 'eligible',
      });

      const result = await service.retrySettlement(bookingId);

      expect(result.settled).toBe(false);
      expect(result.error).toBe('No failed settlement to retry');
    });
  });

  // ─── getSettlementStatus ──────────────────────────────────────────

  describe('getSettlementStatus', () => {
    it('should return settlement details', async () => {
      paymentRepo.findOne.mockResolvedValue({ ...baseSeparatePayment });

      const result = await service.getSettlementStatus(bookingId);

      expect(result.bookingId).toBe(bookingId);
      expect(result.paymentModel).toBe('separate');
      expect(result.settlementStatus).toBe('eligible');
      expect(result.readerPayoutCents).toBe(8500);
    });

    it('should return null when no payment record exists', async () => {
      paymentRepo.findOne.mockResolvedValue(null);

      const result = await service.getSettlementStatus(bookingId);

      expect(result).toBeNull();
    });
  });
});
