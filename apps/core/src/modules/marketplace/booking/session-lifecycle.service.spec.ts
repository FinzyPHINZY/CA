/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Booking,
  BookingStatus,
  PaymentRecord,
  PaymentRecordStatus,
  ReaderProfile,
  TimeSlot,
  TimeSlotStatus,
} from '@app/common';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BookedRehearsalService } from '../../rehearsal/booked-rehearsal.service';
import { RefundOrchestrationService } from './refund-orchestration.service';
import { SessionLifecycleService } from './session-lifecycle.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
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

describe('SessionLifecycleService', () => {
  let service: SessionLifecycleService;

  let bookingRepo: ReturnType<typeof mockRepository>;
  let slotRepo: ReturnType<typeof mockRepository>;
  let profileRepo: ReturnType<typeof mockRepository>;
  let paymentRepo: ReturnType<typeof mockRepository>;
  let refundOrchestrationService: jest.Mocked<
    Partial<RefundOrchestrationService>
  >;
  let bookedRehearsalService: jest.Mocked<Partial<BookedRehearsalService>>;

  const bookingId = 'booking-1';
  const readerProfileId = 'profile-1';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    bookingRepo = mockRepository();
    slotRepo = mockRepository();
    profileRepo = mockRepository();
    paymentRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[Booking.name] = bookingRepo;
    repoMap[TimeSlot.name] = slotRepo;
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[PaymentRecord.name] = paymentRepo;

    const mockManager = {
      getRepository: jest.fn((entity) => repoMap[entity.name]),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    refundOrchestrationService = {
      processBookingRefund: jest.fn().mockResolvedValue({
        action: 'refunded',
        booking: { id: bookingId },
        paymentRecord: null,
        refundId: 're_123',
        transferReversalId: 'trr_123',
        refundStatus: 'succeeded',
        reversalStatus: 'pending_webhook',
        reason: 'Reader no-show',
      }),
    };
    bookedRehearsalService = {
      markCancelledByBookingId: jest.fn(),
      markCompleted: jest.fn(),
    };

    const mockSettlementService = { settleBooking: jest.fn() } as any;
    const mockFeedbackNotificationService = {
      requestFeedbackAfterCompletion: jest.fn().mockResolvedValue(undefined),
    } as any;
    service = new SessionLifecycleService(
      mockDataSource,
      refundOrchestrationService as unknown as RefundOrchestrationService,
      bookedRehearsalService as unknown as BookedRehearsalService,
      mockSettlementService,
      mockFeedbackNotificationService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── detectNoShows ──────────────────────────────────────────────────

  describe('detectNoShows', () => {
    it('should mark overdue confirmed bookings as NO_SHOW', async () => {
      const pastEnd = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      const booking = {
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        sessionEndUtc: pastEnd,
      };

      const qb = mockQueryBuilder([booking]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);

      const count = await service.detectNoShows();

      expect(count).toBe(1);
      expect(booking.status).toBe(BookingStatus.NO_SHOW);
      expect(bookingRepo.save).toHaveBeenCalledWith(booking);
    });

    it('should respect 5-minute grace period', async () => {
      // Session ended 3 minutes ago — within 5min grace, should NOT be marked
      const recentEnd = new Date(Date.now() - 3 * 60 * 1000);
      const booking = {
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        sessionEndUtc: recentEnd,
      };

      const qb = mockQueryBuilder([booking]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);

      const count = await service.detectNoShows();

      expect(count).toBe(0);
      expect(booking.status).toBe(BookingStatus.CONFIRMED); // unchanged
    });

    it('should mark as NO_SHOW when exactly past grace period', async () => {
      // Session ended 6 minutes ago — past 5min grace
      const pastGrace = new Date(Date.now() - 6 * 60 * 1000);
      const booking = {
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        sessionEndUtc: pastGrace,
      };

      const qb = mockQueryBuilder([booking]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);

      const count = await service.detectNoShows();

      expect(count).toBe(1);
      expect(booking.status).toBe(BookingStatus.NO_SHOW);
    });

    it('should return 0 when no candidates found', async () => {
      const qb = mockQueryBuilder([]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);

      const count = await service.detectNoShows();

      expect(count).toBe(0);
    });

    it('should handle multiple bookings and only mark overdue ones', async () => {
      const overdueBooking = {
        id: 'overdue-1',
        status: BookingStatus.CONFIRMED,
        sessionEndUtc: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
      };
      const withinGraceBooking = {
        id: 'grace-1',
        status: BookingStatus.CONFIRMED,
        sessionEndUtc: new Date(Date.now() - 2 * 60 * 1000), // 2 min ago
      };

      const qb = mockQueryBuilder([overdueBooking, withinGraceBooking]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);

      const count = await service.detectNoShows();

      expect(count).toBe(1);
      expect(overdueBooking.status).toBe(BookingStatus.NO_SHOW);
      expect(withinGraceBooking.status).toBe(BookingStatus.CONFIRMED);
    });
  });

  // ─── resolveNoShow ──────────────────────────────────────────────────

  describe('resolveNoShow', () => {
    const noShowBooking = {
      id: bookingId,
      status: BookingStatus.NO_SHOW,
      timeSlotId: 'slot-1',
      readerProfileId,
      noShowBy: null,
      noShowResolvedAt: null,
      noShowResolvedByUserId: null,
    };

    const paymentRecord = {
      bookingId,
      amountCents: 10000,
      status: PaymentRecordStatus.SUCCEEDED,
      refundAmountCents: null,
      refundReason: null,
      refundedAt: null,
    };

    it('should full refund actor when reader no-shows', async () => {
      bookingRepo.findOne.mockResolvedValue({ ...noShowBooking });
      paymentRepo.findOne.mockResolvedValue({ ...paymentRecord });
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });

      const result = await service.resolveNoShow(
        bookingId,
        'reader',
        'admin-user-1',
      );

      expect(result.noShowBy).toBe('reader');
      expect(result.resolved).toBe(true);
      expect(result.resolvedByUserId).toBe('admin-user-1');
      expect(result.resolvedAt).toBeInstanceOf(Date);
      expect(result.financialState.paymentStatus).toBe(
        PaymentRecordStatus.SUCCEEDED,
      );
      expect(
        refundOrchestrationService.processBookingRefund,
      ).toHaveBeenCalledWith(
        bookingId,
        expect.objectContaining({
          amountCents: 10000,
          outcomeCode: 'reader_no_show',
          reason: 'Reader no-show',
        }),
      );
    });

    it('should not refund when actor no-shows (reader keeps pay)', async () => {
      bookingRepo.findOne.mockResolvedValue({ ...noShowBooking });
      paymentRepo.findOne.mockResolvedValue({ ...paymentRecord });
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });

      const result = await service.resolveNoShow(
        bookingId,
        'actor',
        'admin-user-1',
      );

      expect(result.noShowBy).toBe('actor');
      expect(result.resolved).toBe(true);
      expect(result.resolvedByUserId).toBe('admin-user-1');
      expect(
        refundOrchestrationService.processBookingRefund,
      ).not.toHaveBeenCalled();
    });

    it('should mark slot as COMPLETED on resolution', async () => {
      bookingRepo.findOne.mockResolvedValue({ ...noShowBooking });
      paymentRepo.findOne.mockResolvedValue({ ...paymentRecord });
      slotRepo.findOne.mockResolvedValue({
        id: 'slot-1',
        status: TimeSlotStatus.CONFIRMED,
      });

      await service.resolveNoShow(bookingId, 'reader');

      expect(bookingRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          noShowBy: 'reader',
          noShowResolvedAt: expect.any(Date),
        }),
      );
      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TimeSlotStatus.COMPLETED }),
      );
    });

    it('should return null if booking is not in NO_SHOW status', async () => {
      bookingRepo.findOne.mockResolvedValue({
        ...noShowBooking,
        status: BookingStatus.CONFIRMED,
      });

      const result = await service.resolveNoShow(bookingId, 'reader');

      expect(result).toBeNull();
    });

    it('should return null if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      const result = await service.resolveNoShow(bookingId, 'reader');

      expect(result).toBeNull();
    });

    it('releases blocked sub-slots on no-show resolution', async () => {
      bookingRepo.findOne.mockResolvedValue({ ...noShowBooking });
      paymentRepo.findOne.mockResolvedValue({ ...paymentRecord });
      slotRepo.findOne.mockResolvedValue({
        id: 'slot-1',
        status: TimeSlotStatus.CONFIRMED,
      });

      await service.resolveNoShow(bookingId, 'reader');

      expect(slotRepo.update).toHaveBeenCalledWith(
        { blockedByBookingId: bookingId },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );
    });

    it('should not process refund twice when no-show resolution is repeated', async () => {
      const mutablePaymentRecord: any = {
        ...paymentRecord,
      };

      bookingRepo.findOne.mockResolvedValue({ ...noShowBooking });
      paymentRepo.findOne.mockImplementation(async () => mutablePaymentRecord);
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });
      refundOrchestrationService.processBookingRefund.mockImplementation(
        (async () => {
          mutablePaymentRecord.status = PaymentRecordStatus.REFUNDED;
          return {
            action: 'refunded' as const,
            booking: { id: bookingId } as any,
            paymentRecord: mutablePaymentRecord,
            refundId: 're_123',
            transferReversalId: 'trr_123',
            refundStatus: 'succeeded',
            reversalStatus: 'pending_webhook',
            reason: 'Reader no-show',
          };
        }) as any,
      );

      await service.resolveNoShow(bookingId, 'reader');
      await service.resolveNoShow(bookingId, 'reader');

      expect(
        refundOrchestrationService.processBookingRefund,
      ).toHaveBeenCalledTimes(1);
    });
  });

  // ─── completeBooking ────────────────────────────────────────────────

  describe('completeBookingForAdmin', () => {
    it('rejects completion from held status', async () => {
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.HELD,
      });

      await expect(
        service.completeBookingForAdmin(bookingId),
      ).rejects.toThrow('Booking cannot be completed');
    });
  });

  describe('completeBooking', () => {
    it('should mark booking as COMPLETED with timestamp', async () => {
      const booking = {
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        timeSlotId: 'slot-1',
        readerProfileId,
        completedAt: null,
      };
      bookingRepo.findOne.mockResolvedValue(booking);
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        totalSessions: 5,
      });

      const result = await service.completeBooking(bookingId);

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(result.completedAt).toBeInstanceOf(Date);
    });

    it('should mark slot as COMPLETED', async () => {
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        timeSlotId: 'slot-1',
        readerProfileId,
      });
      slotRepo.findOne.mockResolvedValue({
        id: 'slot-1',
        status: TimeSlotStatus.CONFIRMED,
      });
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        totalSessions: 5,
      });

      await service.completeBooking(bookingId);

      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TimeSlotStatus.COMPLETED }),
      );
    });

    it('should increment reader totalSessions', async () => {
      const profile = { id: readerProfileId, totalSessions: 5 };
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        timeSlotId: 'slot-1',
        readerProfileId,
      });
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });
      profileRepo.findOne.mockResolvedValue(profile);

      await service.completeBooking(bookingId);

      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ totalSessions: 6 }),
      );
    });

    it('should return null if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      const result = await service.completeBooking(bookingId);

      expect(result).toBeNull();
    });

    it('should transition to AWAITING_SETTLEMENT for separate-charge payments', async () => {
      const booking = {
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        timeSlotId: 'slot-1',
        readerProfileId,
        completedAt: null,
      };
      const payment = {
        bookingId,
        paymentModel: 'separate',
        settlementStatus: 'pending',
        settlementEligibleAt: null,
      };

      bookingRepo.findOne.mockResolvedValue(booking);
      paymentRepo.findOne.mockResolvedValue(payment);
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        totalSessions: 5,
      });

      const result = await service.completeBooking(bookingId);

      expect(result.status).toBe(BookingStatus.AWAITING_SETTLEMENT);
      expect(result.completedAt).toBeNull(); // not completed yet
      expect(payment.settlementStatus).toBe('eligible');
      expect(payment.settlementEligibleAt).toBeInstanceOf(Date);
    });

    it('should still complete immediately for destination-charge payments', async () => {
      const booking = {
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        timeSlotId: 'slot-1',
        readerProfileId,
        completedAt: null,
      };
      const payment = {
        bookingId,
        paymentModel: 'destination',
        settlementStatus: null,
      };

      bookingRepo.findOne.mockResolvedValue(booking);
      paymentRepo.findOne.mockResolvedValue(payment);
      slotRepo.findOne.mockResolvedValue({ id: 'slot-1' });
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        totalSessions: 5,
      });

      const result = await service.completeBooking(bookingId);

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(result.completedAt).toBeInstanceOf(Date);
    });
  });

  // ─── getBookingDetail ───────────────────────────────────────────────

  describe('getBookingDetail', () => {
    const booking = {
      id: bookingId,
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
      readerProfileId,
    };

    it('should return detail for authorized actor', async () => {
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        userId: 'reader-1',
        headline: 'Great reader',
        bio: 'Bio',
        avgRating: 4.5,
        totalSessions: 10,
      });
      paymentRepo.findOne.mockResolvedValue({
        status: PaymentRecordStatus.SUCCEEDED,
        amountCents: 5000,
        platformFeeCents: 750,
        readerPayoutCents: 4250,
        currency: 'USD',
      });

      const result = await service.getBookingDetail(bookingId, 'actor-1');

      expect(result.booking.id).toBe(bookingId);
      expect(result.readerProfile.headline).toBe('Great reader');
      expect(result.payment.amountCents).toBe(5000);
    });

    it('should return null if user is not actor or reader', async () => {
      bookingRepo.findOne.mockResolvedValue(booking);

      const result = await service.getBookingDetail(bookingId, 'random-user');

      expect(result).toBeNull();
    });

    it('should return null if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      const result = await service.getBookingDetail(bookingId, 'actor-1');

      expect(result).toBeNull();
    });
  });
});
