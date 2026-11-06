/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { PaymentRecord, PaymentRecordStatus } from '@app/common';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettlementCronService } from './settlement-cron.service';
import { SettlementService } from './settlement.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn((entity) => Promise.resolve(entity)),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function mockQueryBuilder(result: any[] = []) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(result),
  };
}

describe('SettlementCronService', () => {
  let service: SettlementCronService;
  let paymentRepo: ReturnType<typeof mockRepository>;
  let settlementService: jest.Mocked<Partial<SettlementService>>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    paymentRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {
      [PaymentRecord.name]: paymentRepo,
    };

    const mockDataSource = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    settlementService = {
      settleBooking: jest
        .fn()
        .mockResolvedValue({ settled: true, transferId: 'tr_1' }),
      retrySettlement: jest
        .fn()
        .mockResolvedValue({ settled: true, transferId: 'tr_retry_1' }),
    };

    service = new SettlementCronService(
      mockDataSource,
      settlementService as unknown as SettlementService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── processEligibleSettlements ───────────────────────────────────

  describe('processEligibleSettlements', () => {
    it('should process eligible settlements past their window', async () => {
      const eligible = [
        { bookingId: 'b1', settlementEligibleAt: new Date(Date.now() - 1000) },
        { bookingId: 'b2', settlementEligibleAt: new Date(Date.now() - 2000) },
      ];
      paymentRepo.find.mockResolvedValue(eligible);

      await service.processEligibleSettlements();

      expect(settlementService.settleBooking).toHaveBeenCalledTimes(2);
      expect(settlementService.settleBooking).toHaveBeenCalledWith('b1');
      expect(settlementService.settleBooking).toHaveBeenCalledWith('b2');
    });

    it('should do nothing when no eligible records exist', async () => {
      paymentRepo.find.mockResolvedValue([]);

      await service.processEligibleSettlements();

      expect(settlementService.settleBooking).not.toHaveBeenCalled();
    });

    it('should continue processing remaining records when one fails', async () => {
      const eligible = [{ bookingId: 'b1' }, { bookingId: 'b2' }];
      paymentRepo.find.mockResolvedValue(eligible);
      settlementService.settleBooking
        .mockResolvedValueOnce({ settled: false, error: 'lock failed' })
        .mockResolvedValueOnce({ settled: true, transferId: 'tr_2' });

      await service.processEligibleSettlements();

      expect(settlementService.settleBooking).toHaveBeenCalledTimes(2);
    });
  });

  // ─── retryFailedSettlements ───────────────────────────────────────

  describe('retryFailedSettlements', () => {
    it('should retry failed settlements within retry limit', async () => {
      const failed = [
        {
          bookingId: 'b1',
          settlementMetaData: {
            retryCount: 1,
            lastFailedAt: new Date(
              Date.now() - 2 * 60 * 60 * 1000,
            ).toISOString(), // 2h ago
          },
        },
      ];

      const qb = mockQueryBuilder(failed);
      paymentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.retryFailedSettlements();

      expect(settlementService.retrySettlement).toHaveBeenCalledWith('b1');
    });

    it('should skip records that exceed max retries and flag for manual review', async () => {
      const failed = [
        {
          bookingId: 'b1',
          settlementMetaData: {
            retryCount: 3,
            lastFailedAt: new Date(
              Date.now() - 2 * 60 * 60 * 1000,
            ).toISOString(),
          },
        },
      ];

      const qb = mockQueryBuilder(failed);
      paymentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.retryFailedSettlements();

      expect(settlementService.retrySettlement).not.toHaveBeenCalled();
      expect(paymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          settlementMetaData: expect.objectContaining({
            flaggedForManualReview: true,
          }),
        }),
      );
    });

    it('should skip records still within cooldown period', async () => {
      const failed = [
        {
          bookingId: 'b1',
          settlementMetaData: {
            retryCount: 1,
            lastFailedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10min ago (within 1h cooldown)
          },
        },
      ];

      const qb = mockQueryBuilder(failed);
      paymentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.retryFailedSettlements();

      expect(settlementService.retrySettlement).not.toHaveBeenCalled();
    });

    it('should do nothing when no failed records exist', async () => {
      const qb = mockQueryBuilder([]);
      paymentRepo.createQueryBuilder.mockReturnValue(qb);

      await service.retryFailedSettlements();

      expect(settlementService.retrySettlement).not.toHaveBeenCalled();
    });
  });
});
