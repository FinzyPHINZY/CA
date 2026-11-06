/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  Booking,
  BookingStatus,
  CancellationPolicy,
  PaymentRecord,
  PaymentRecordStatus,
  ReaderProfile,
  ReaderSessionRate,
  RedisLockService,
  TimeSlot,
  TimeSlotStatus,
} from '@app/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { BookingService } from './booking.service';
import { ConnectPaymentService } from './connect-payment.service';
import { FeeCalculationService } from './fee-calculation.service';
import { RefundOrchestrationService } from './refund-orchestration.service';
import { SessionLifecycleService } from './session-lifecycle.service';

type EntityRecord = Record<string, any>;

function createStatefulRepository(store: EntityRecord[]) {
  return {
    findOne: jest.fn(async ({ where }: { where?: Record<string, any> }) => {
      if (!where) return store[0] ?? null;
      return (
        store.find((item) =>
          Object.entries(where).every(([key, value]) => item[key] === value),
        ) ?? null
      );
    }),
    find: jest.fn(async ({ where }: { where?: Record<string, any> }) => {
      if (!where) return [...store];
      return store.filter((item) =>
        Object.entries(where).every(([key, value]) => {
          if (value && typeof value === 'object' && '_value' in value) {
            const list = (value as any)._value;
            return Array.isArray(list) ? list.includes(item[key]) : false;
          }
          return item[key] === value;
        }),
      );
    }),
    save: jest.fn(async (entity: any) => {
      const index = store.findIndex((item) => item.id === entity.id);
      if (index >= 0) {
        store[index] = entity;
      } else {
        store.push(entity);
      }
      return entity;
    }),
    update: jest.fn(
      async (criteria: Record<string, any>, partial: Record<string, any>) => {
        let affected = 0;
        for (const item of store) {
          const matches = Object.entries(criteria).every(
            ([key, value]) => item[key] === value,
          );
          if (matches) {
            Object.assign(item, partial);
            affected += 1;
          }
        }
        return { affected };
      },
    ),
    create: jest.fn((data: any) => data),
    findAndCount: jest.fn(
      async ({ where }: { where?: Record<string, any> }) => {
        const items = where
          ? store.filter((item) =>
              Object.entries(where).every(
                ([key, value]) => item[key] === value,
              ),
            )
          : [...store];
        return [items, items.length];
      },
    ),
    createQueryBuilder: jest.fn(),
  };
}

describe('Booking refund integration flows', () => {
  let bookingService: BookingService;
  let sessionLifecycleService: SessionLifecycleService;
  let connectPaymentService: ConnectPaymentService;

  let bookingStore: EntityRecord[];
  let paymentRecordStore: EntityRecord[];
  let timeSlotStore: EntityRecord[];
  let profileStore: EntityRecord[];
  let rateStore: EntityRecord[];
  let repoMap: Record<string, ReturnType<typeof createStatefulRepository>>;
  let bookedRehearsalService: {
    ensureForBooking: jest.Mock;
    markCancelledByBookingId: jest.Mock;
    markCompleted: jest.Mock;
  };

  const actorUserId = 'actor-1';
  const readerUserId = 'reader-1';
  const readerProfileId = 'profile-1';
  const timeSlotId = 'slot-1';

  const buildSharedDataSource = () => {
    const manager = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    };

    return {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
      transaction: jest.fn(async (cb) => cb(manager)),
    } as unknown as DataSource;
  };

  const seedConfirmedBooking = (
    overrides: Partial<Booking> = {},
    paymentOverrides: Partial<PaymentRecord> = {},
  ) => {
    const booking = {
      id: 'booking-1',
      actorUserId,
      readerUserId,
      readerProfileId,
      timeSlotId,
      status: BookingStatus.CONFIRMED,
      priceCents: 10000,
      currency: 'USD',
      sessionDurationMinutes: 30,
      sessionStartUtc: new Date(Date.now() + 48 * 60 * 60 * 1000),
      sessionEndUtc: new Date(Date.now() + 49 * 60 * 60 * 1000),
      stripePaymentIntentId: 'pi_123',
      platformFeeCents: 1500,
      metaData: null,
      ...overrides,
    };
    const paymentRecord = {
      id: 'pr_1',
      bookingId: booking.id,
      actorUserId,
      readerUserId,
      stripePaymentIntentId: 'pi_123',
      stripeTransferId: 'tr_123',
      amountCents: 10000,
      platformFeeCents: 1500,
      readerPayoutCents: 8500,
      currency: 'USD',
      status: PaymentRecordStatus.SUCCEEDED,
      refundMetaData: null,
      ...paymentOverrides,
    };

    bookingStore = [booking];
    paymentRecordStore = [paymentRecord];
    timeSlotStore = [
      {
        id: timeSlotId,
        bookingId: booking.id,
        status: TimeSlotStatus.CONFIRMED,
      },
    ];
    profileStore = [
      {
        id: readerProfileId,
        userId: readerUserId,
        cancellationPolicy: CancellationPolicy.FLEXIBLE,
        totalSessions: 0,
      },
    ];
    rateStore = [
      {
        id: 'rate_1',
        readerProfileId,
        durationMinutes: 30,
        priceCents: 10000,
      },
    ];
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    seedConfirmedBooking();

    repoMap = {
      [Booking.name]: createStatefulRepository(bookingStore),
      [PaymentRecord.name]: createStatefulRepository(paymentRecordStore),
      [TimeSlot.name]: createStatefulRepository(timeSlotStore),
      [ReaderProfile.name]: createStatefulRepository(profileStore),
      [ReaderSessionRate.name]: createStatefulRepository(rateStore),
    };

    const dataSource = buildSharedDataSource();

    const redisLockService = {
      acquireLock: jest.fn(),
      releaseLock: jest.fn(),
      isLocked: jest.fn().mockResolvedValue(false),
      get: jest.fn().mockResolvedValue(null),
      setWithTTL: jest.fn().mockResolvedValue(undefined),
    } as unknown as RedisLockService;

    const feeCalculationService = new FeeCalculationService();

    connectPaymentService = new ConnectPaymentService(
      {
        get: jest.fn((key: string) =>
          key === 'STRIPE_SECRET_KEY' ? 'sk_test_123' : undefined,
        ),
      } as unknown as ConfigService,
      dataSource,
      feeCalculationService,
      redisLockService,
      { emit: jest.fn() } as any,
    );

    (connectPaymentService as any).stripe = {
      refunds: {
        create: jest.fn().mockResolvedValue({
          id: 're_123',
          status: 'succeeded',
          transfer_reversal: 'trr_123',
          source_transfer_reversal: null,
        }),
      },
    };

    const mockConfigService = { get: jest.fn().mockReturnValue(null) } as any;
    const refundOrchestrationService = new RefundOrchestrationService(
      dataSource,
      connectPaymentService,
      mockConfigService,
    );

    bookedRehearsalService = {
      ensureForBooking: jest.fn(),
      markCancelledByBookingId: jest.fn(),
      markCompleted: jest.fn(),
    };

    bookingService = new BookingService(
      dataSource,
      redisLockService,
      feeCalculationService,
      {
        emitBookingStatusChange: jest.fn().mockResolvedValue(undefined),
        scheduleReminders: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        generateBookingIcs: jest.fn().mockReturnValue('BEGIN:VCALENDAR'),
      } as any,
      {
        pushBookingEvent: jest.fn().mockResolvedValue(undefined),
        deleteBookingEvent: jest.fn().mockResolvedValue(undefined),
      } as any,
      refundOrchestrationService,
      bookedRehearsalService as any,
    );

    const mockSettlementService = { settleBooking: jest.fn() } as any;
    const mockFeedbackNotificationService = {
      requestFeedbackAfterCompletion: jest.fn().mockResolvedValue(undefined),
    } as any;
    sessionLifecycleService = new SessionLifecycleService(
      dataSource,
      refundOrchestrationService,
      bookedRehearsalService as any,
      mockSettlementService,
      mockFeedbackNotificationService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refunds and releases slot when actor cancels a paid booking', async () => {
    const result = await bookingService.cancelByActor('booking-1', actorUserId);

    expect(result.data.booking.status).toBe(BookingStatus.CANCELLED);
    expect(result.data.refundExecution?.refundId).toBe('re_123');
    expect(paymentRecordStore[0].stripeRefundId).toBe('re_123');
    expect(paymentRecordStore[0].reversalStatus).toBe('pending_webhook');
    expect(timeSlotStore[0].status).toBe(TimeSlotStatus.AVAILABLE);
    expect(timeSlotStore[0].bookingId).toBeNull();
  });

  it('refunds and releases slot when reader cancels a paid booking', async () => {
    const result = await bookingService.cancelByReader(
      'booking-1',
      readerUserId,
    );

    expect(result.data.booking.status).toBe(BookingStatus.CANCELLED);
    expect(result.data.refund.refundPercent).toBe(100);
    expect(paymentRecordStore[0].stripeRefundId).toBe('re_123');
    expect(timeSlotStore[0].status).toBe(TimeSlotStatus.AVAILABLE);
  });

  it('refunds on reader no-show using the same orchestration path', async () => {
    bookingStore[0].status = BookingStatus.NO_SHOW;

    const result = await sessionLifecycleService.resolveNoShow(
      'booking-1',
      'reader',
      'admin-1',
    );

    expect(result.noShowBy).toBe('reader');
    expect(result.resolvedByUserId).toBe('admin-1');
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(result.refundExecution?.refundId).toBe('re_123');
    expect(paymentRecordStore[0].stripeRefundId).toBe('re_123');
    expect(result.financialState.refundStatus).toBe('succeeded');
    expect(timeSlotStore[0].status).toBe(TimeSlotStatus.COMPLETED);
    expect(bookingStore[0].noShowBy).toBe('reader');
    expect(bookingStore[0].noShowResolvedByUserId).toBe('admin-1');
    expect(bookingStore[0].noShowResolvedAt).toBeInstanceOf(Date);
  });
});
