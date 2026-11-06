/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Booking,
  BookingStatus,
  BookingType,
  CancellationPolicy,
  PaymentRecord,
  ReaderProfile,
  ReaderSessionRate,
  ReaderSpecialty,
  RedisLockService,
  TimeSlot,
  TimeSlotStatus,
  User,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { BookedRehearsalService } from '../../rehearsal/booked-rehearsal.service';
import { BookingService } from './booking.service';
import { FeeCalculationService } from './fee-calculation.service';
import { RefundOrchestrationService } from './refund-orchestration.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ id: 'new-booking-id', ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function mockQueryBuilder(result: any = [], count: number = 0) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(result),
    getManyAndCount: jest.fn().mockResolvedValue([result, count]),
    getCount: jest.fn().mockResolvedValue(count),
  };
  return qb;
}

describe('BookingService', () => {
  let service: BookingService;
  let mockDataSource: jest.Mocked<Partial<DataSource>>;
  let mockRedisLockService: jest.Mocked<Partial<RedisLockService>>;
  let feeCalculationService: FeeCalculationService;

  let bookingRepo: ReturnType<typeof mockRepository>;
  let slotRepo: ReturnType<typeof mockRepository>;
  let profileRepo: ReturnType<typeof mockRepository>;
  let rateRepo: ReturnType<typeof mockRepository>;
  let paymentRecordRepo: ReturnType<typeof mockRepository>;
  let userRepo: ReturnType<typeof mockRepository>;
  let specialtyRepo: ReturnType<typeof mockRepository>;
  let refundOrchestrationService: jest.Mocked<
    Partial<RefundOrchestrationService>
  >;
  let bookedRehearsalService: jest.Mocked<Partial<BookedRehearsalService>>;

  const actorUserId = 'actor-user-1';
  const readerUserId = 'reader-user-1';
  const readerProfileId = 'reader-profile-1';
  const bookingId = 'booking-1';
  const timeSlotId = 'slot-1';

  function hoursFromNow(hours: number): Date {
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }

  function makeConfirmedBooking(
    sessionStartUtc: Date,
    overrides: Partial<Booking> = {},
  ): Partial<Booking> {
    const sessionDurationMinutes = overrides.sessionDurationMinutes ?? 60;
    const sessionEndUtc =
      overrides.sessionEndUtc ??
      new Date(sessionStartUtc.getTime() + sessionDurationMinutes * 60 * 1000);
    return {
      id: bookingId,
      actorUserId,
      readerUserId,
      readerProfileId,
      timeSlotId,
      status: BookingStatus.CONFIRMED,
      priceCents: 10000,
      sessionStartUtc,
      sessionEndUtc,
      sessionDurationMinutes,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    bookingRepo = mockRepository();
    slotRepo = mockRepository();
    profileRepo = mockRepository();
    rateRepo = mockRepository();
    paymentRecordRepo = mockRepository();
    userRepo = mockRepository({ find: jest.fn().mockResolvedValue([]) });
    specialtyRepo = mockRepository({ find: jest.fn().mockResolvedValue([]) });

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[Booking.name] = bookingRepo;
    repoMap[TimeSlot.name] = slotRepo;
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[ReaderSessionRate.name] = rateRepo;
    repoMap[PaymentRecord.name] = paymentRecordRepo;
    repoMap[User.name] = userRepo;
    repoMap[ReaderSpecialty.name] = specialtyRepo;

    const mockManager = {
      getRepository: jest.fn((entity) => repoMap[entity.name]),
    };

    mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as jest.Mocked<Partial<DataSource>>;

    mockRedisLockService = {
      acquireLock: jest.fn(),
      releaseLock: jest.fn(),
      isLocked: jest.fn(),
    };

    refundOrchestrationService = {
      processBookingRefund: jest.fn().mockResolvedValue({
        action: 'refunded',
        booking: { id: bookingId },
        paymentRecord: null,
        refundId: 're_123',
        transferReversalId: 'trr_123',
        refundStatus: 'succeeded',
        reversalStatus: 'pending_webhook',
        reason: 'test',
      }),
    };
    bookedRehearsalService = {
      ensureForBooking: jest.fn(),
      findManyByBookingIds: jest.fn().mockResolvedValue([]),
      markCancelledByBookingId: jest.fn(),
    };

    feeCalculationService = new FeeCalculationService();

    service = new BookingService(
      mockDataSource as unknown as DataSource,
      mockRedisLockService as unknown as RedisLockService,
      feeCalculationService,
      {
        emitBookingStatusChange: jest.fn().mockResolvedValue(undefined),
        scheduleReminders: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        generateBookingIcs: jest
          .fn()
          .mockReturnValue('BEGIN:VCALENDAR\r\nEND:VCALENDAR'),
      } as any,
      {
        pushBookingEvent: jest.fn().mockResolvedValue(undefined),
        deleteBookingEvent: jest.fn().mockResolvedValue(undefined),
      } as any,
      refundOrchestrationService as unknown as RefundOrchestrationService,
      bookedRehearsalService as unknown as BookedRehearsalService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── Cancellation Policy: FLEXIBLE ──────────────────────────────────

  describe('cancelByActor — FLEXIBLE policy', () => {
    const flexibleProfile: Partial<ReaderProfile> = {
      id: readerProfileId,
      cancellationPolicy: CancellationPolicy.FLEXIBLE,
    };

    it('should give full refund when >24h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(48));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(flexibleProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(100);
      expect(result.data.refund.refundCents).toBe(10000);
      expect(result.data.booking.status).toBe(BookingStatus.CANCELLED);
    });

    it('should give 50% refund when 12-24h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(18));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(flexibleProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(50);
      expect(result.data.refund.refundCents).toBe(5000);
      expect(
        refundOrchestrationService.processBookingRefund,
      ).toHaveBeenCalledWith(
        bookingId,
        expect.objectContaining({
          amountCents: 5000,
          outcomeCode: 'actor_cancel',
        }),
      );
    });

    it('should give no refund when <12h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(6));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(flexibleProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(0);
      expect(result.data.refund.refundCents).toBe(0);
      expect(
        refundOrchestrationService.processBookingRefund,
      ).not.toHaveBeenCalled();
    });

    it('should give 50% refund at exactly 13h (inside 12-24h window)', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(13));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(flexibleProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(50);
    });

    it('should give full refund at exactly 25h (inside >24h window)', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(25));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(flexibleProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(100);
    });
  });

  // ─── Cancellation Policy: MODERATE ──────────────────────────────────

  describe('cancelByActor — MODERATE policy', () => {
    const moderateProfile: Partial<ReaderProfile> = {
      id: readerProfileId,
      cancellationPolicy: CancellationPolicy.MODERATE,
    };

    it('should give full refund when >48h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(72));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(moderateProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(100);
      expect(result.data.refund.refundCents).toBe(10000);
    });

    it('should give 50% refund when 24-48h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(36));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(moderateProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(50);
    });

    it('should give no refund when <24h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(12));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(moderateProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(0);
    });
  });

  // ─── Cancellation Policy: STRICT ────────────────────────────────────

  describe('cancelByActor — STRICT policy', () => {
    const strictProfile: Partial<ReaderProfile> = {
      id: readerProfileId,
      cancellationPolicy: CancellationPolicy.STRICT,
    };

    it('should give full refund when >7 days before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(200)); // ~8 days
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(strictProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(100);
    });

    it('should give 50% refund when 48h-7d before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(96)); // 4 days
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(strictProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(50);
    });

    it('should give no refund when <48h before session', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(24));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue(strictProfile);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      expect(result.data.refund.refundPercent).toBe(0);
    });
  });

  // ─── Cancellation Policy: Default / Missing ─────────────────────────

  describe('cancelByActor — default policy', () => {
    it('should default to FLEXIBLE when reader has no cancellation policy', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(48));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue({ id: readerProfileId }); // no policy set
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByActor(bookingId, actorUserId);

      // FLEXIBLE >24h = 100%
      expect(result.data.refund.refundPercent).toBe(100);
    });
  });

  // ─── Reader Cancels (always full refund) ────────────────────────────

  describe('cancelByReader', () => {
    it('should always give full refund regardless of timing', async () => {
      // Even <12h before session, reader cancel = full refund
      const booking = makeConfirmedBooking(hoursFromNow(2), {
        readerUserId,
      });
      bookingRepo.findOne.mockResolvedValue(booking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      const result = await service.cancelByReader(bookingId, readerUserId);

      expect(result.data.refund.refundPercent).toBe(100);
      expect(result.data.refund.refundCents).toBe(10000);
      expect(result.data.booking.status).toBe(BookingStatus.CANCELLED);
      expect(result.data.booking.cancelledBy).toBe('reader');
      expect(
        refundOrchestrationService.processBookingRefund,
      ).toHaveBeenCalledWith(
        bookingId,
        expect.objectContaining({
          amountCents: 10000,
          outcomeCode: 'reader_cancel',
        }),
      );
    });

    it('should reject if user is not the reader on the booking', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(48));
      bookingRepo.findOne.mockResolvedValue(booking);

      await expect(
        service.cancelByReader(bookingId, 'wrong-user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(
        service.cancelByReader(bookingId, readerUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if booking already cancelled', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(48), {
        status: BookingStatus.CANCELLED,
      });
      bookingRepo.findOne.mockResolvedValue(booking);

      await expect(
        service.cancelByReader(bookingId, readerUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not process refund twice when cancellation is repeated', async () => {
      const mutableBooking: any = makeConfirmedBooking(hoursFromNow(48), {
        readerUserId,
      });
      bookingRepo.findOne.mockImplementation(async () => mutableBooking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      await service.cancelByReader(bookingId, readerUserId);

      await expect(
        service.cancelByReader(bookingId, readerUserId),
      ).rejects.toThrow(BadRequestException);
      expect(
        refundOrchestrationService.processBookingRefund,
      ).toHaveBeenCalledTimes(1);
    });
  });

  // ─── cancelByActor: shared guards ───────────────────────────────────

  describe('cancelByActor — authorization & status guards', () => {
    it('should reject if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(
        service.cancelByActor(bookingId, actorUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if user is not the actor on the booking', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeConfirmedBooking(hoursFromNow(48)),
      );

      await expect(
        service.cancelByActor(bookingId, 'wrong-user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject if booking is already completed', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeConfirmedBooking(hoursFromNow(48), {
          status: BookingStatus.COMPLETED,
        }),
      );

      await expect(
        service.cancelByActor(bookingId, actorUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if booking is already cancelled', async () => {
      bookingRepo.findOne.mockResolvedValue(
        makeConfirmedBooking(hoursFromNow(48), {
          status: BookingStatus.CANCELLED,
        }),
      );

      await expect(
        service.cancelByActor(bookingId, actorUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should release the slot back to AVAILABLE on cancellation', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(48));
      const slot = {
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
        bookingId: null,
      };

      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        cancellationPolicy: CancellationPolicy.FLEXIBLE,
      });
      slotRepo.findOne.mockResolvedValue(slot);

      await service.cancelByActor(bookingId, actorUserId);

      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TimeSlotStatus.AVAILABLE,
          bookingId: null,
        }),
      );
    });

    it('should set cancellation reason from input', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(48));
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        cancellationPolicy: CancellationPolicy.FLEXIBLE,
      });
      slotRepo.findOne.mockResolvedValue({ id: timeSlotId });

      const result = await service.cancelByActor(
        bookingId,
        actorUserId,
        'Schedule conflict',
      );

      expect(result.data.booking.cancellationReason).toBe('Schedule conflict');
    });
  });

  // ─── Refund rounding ────────────────────────────────────────────────

  describe('refund rounding', () => {
    it('should floor 50% refund on odd amounts', async () => {
      const booking = makeConfirmedBooking(hoursFromNow(18), {
        priceCents: 3333,
      });
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        cancellationPolicy: CancellationPolicy.FLEXIBLE,
      });
      slotRepo.findOne.mockResolvedValue({ id: timeSlotId });

      const result = await service.cancelByActor(bookingId, actorUserId);

      // 50% of 3333 = 1666.5 → floor to 1666
      expect(result.data.refund.refundPercent).toBe(50);
      expect(result.data.refund.refundCents).toBe(1666);
    });
  });

  // ─── createBooking ──────────────────────────────────────────────────

  describe('createBooking', () => {
    const futureSlot: Partial<TimeSlot> = {
      id: timeSlotId,
      status: TimeSlotStatus.AVAILABLE,
      startTimeUtc: hoursFromNow(48),
      endTimeUtc: hoursFromNow(49),
    };

    const readerProfile: Partial<ReaderProfile> = {
      id: readerProfileId,
      userId: readerUserId,
      isAcceptingBookings: true,
      bufferMinutes: 10,
    };

    const sessionRate: Partial<ReaderSessionRate> = {
      readerProfileId,
      durationMinutes: 30,
      priceCents: 5000,
      currency: 'USD',
    };

    const dto = {
      readerProfileId,
      timeSlotId,
      sessionDurationMinutes: 30,
    };

    beforeEach(() => {
      // setup createBooking-specific mocks on the non-transactional repos
      profileRepo.findOne.mockResolvedValue(readerProfile);
      rateRepo.findOne.mockResolvedValue(sessionRate);
      slotRepo.findOne.mockResolvedValue({ ...futureSlot });
      // slot createQueryBuilder is used inside the transaction to find overlapping/buffer sub-slots
      slotRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));
      bookingRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));
      mockRedisLockService.acquireLock.mockResolvedValue({
        acquired: true,
        lockToken: 'lock-token-123',
      });
    });

    it('should create a booking with HELD status and correct fees', async () => {
      userRepo.find.mockResolvedValue([
        { id: actorUserId, fullName: 'Actor User', avatar: 'actor.jpg' },
        { id: readerUserId, fullName: 'Reader User', avatar: 'reader.jpg' },
      ]);
      specialtyRepo.find.mockResolvedValue([
        { readerProfileId, genre: 'Drama' },
        { readerProfileId, genre: 'Comedy' },
      ]);

      const result = await service.createBooking(actorUserId, dto);

      expect(result.data.booking.status).toBe(BookingStatus.HELD);
      expect(result.data.booking.priceCents).toBe(5000);
      expect(result.data.booking.actorUserId).toBe(actorUserId);
      expect(result.data.booking.readerUserId).toBe(readerUserId);
      expect(result.data.booking.actor).toEqual({
        name: 'Actor User',
        avatar: 'actor.jpg',
      });
      expect(result.data.booking.reader).toEqual({
        name: 'Reader User',
        avatar: 'reader.jpg',
        genres: ['Drama', 'Comedy'],
      });
      expect(result.data.fees.actorPaysCents).toBe(5000);
      expect(result.data.fees.platformFeeCents).toBe(750);
      expect(result.data.fees.readerReceivesCents).toBe(4250);
    });

    it('should acquire Redis lock on the slot', async () => {
      await service.createBooking(actorUserId, dto);

      expect(mockRedisLockService.acquireLock).toHaveBeenCalledWith(
        `booking:slot:${timeSlotId}`,
        30,
      );
    });

    it('should set slot status to HELD', async () => {
      await service.createBooking(actorUserId, dto);

      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TimeSlotStatus.HELD,
        }),
      );
    });

    it('should reject if reader profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject if reader is not accepting bookings', async () => {
      profileRepo.findOne.mockResolvedValue(null); // query includes isAcceptingBookings: true

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject self-booking', async () => {
      profileRepo.findOne.mockResolvedValue({
        ...readerProfile,
        userId: actorUserId, // same as actor
      });

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject if session duration not offered', async () => {
      rateRepo.findOne.mockResolvedValue(null);

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject if slot not found', async () => {
      slotRepo.findOne.mockResolvedValue(null);

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject if slot is not AVAILABLE', async () => {
      slotRepo.findOne.mockResolvedValue({
        ...futureSlot,
        status: TimeSlotStatus.HELD,
      });

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should reject if slot is in the past', async () => {
      slotRepo.findOne.mockResolvedValue({
        ...futureSlot,
        startTimeUtc: new Date(Date.now() - 60000), // 1 min ago
      });

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject if Redis lock cannot be acquired', async () => {
      mockRedisLockService.acquireLock.mockResolvedValue({
        acquired: false,
        lockToken: null,
      });

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should release Redis lock on failure after acquisition', async () => {
      // force the transaction to fail after lock is acquired
      (mockDataSource.transaction as jest.Mock).mockRejectedValue(
        new Error('DB error'),
      );

      await expect(service.createBooking(actorUserId, dto)).rejects.toThrow(
        'DB error',
      );

      expect(mockRedisLockService.releaseLock).toHaveBeenCalledWith(
        `booking:slot:${timeSlotId}`,
        'lock-token-123',
      );
    });
  });

  // ─── sub-slot blocking & release ────────────────────────────────────

  describe('sub-slot blocking and release', () => {
    const futureSlot: Partial<TimeSlot> = {
      id: timeSlotId,
      status: TimeSlotStatus.AVAILABLE,
      startTimeUtc: new Date(Date.now() + 48 * 60 * 60 * 1000),
      endTimeUtc: new Date(Date.now() + 48.5 * 60 * 60 * 1000),
      availabilityId: 'avail-1',
    };

    const readerProfile: Partial<ReaderProfile> = {
      id: readerProfileId,
      userId: readerUserId,
      isAcceptingBookings: true,
      bufferMinutes: 10,
    };

    const sessionRate: Partial<ReaderSessionRate> = {
      readerProfileId,
      durationMinutes: 60,
      priceCents: 10000,
      currency: 'USD',
    };

    const dto = { readerProfileId, timeSlotId, sessionDurationMinutes: 60 };

    beforeEach(() => {
      profileRepo.findOne.mockResolvedValue(readerProfile);
      rateRepo.findOne.mockResolvedValue(sessionRate);
      slotRepo.findOne.mockResolvedValue({ ...futureSlot });
      slotRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));
      bookingRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));
      mockRedisLockService.acquireLock.mockResolvedValue({
        acquired: true,
        lockToken: 'lock-token-abc',
      });
    });

    it('blocks overlapping sub-slots within the session + buffer window', async () => {
      // Two sub-slots fall within the session + 10-min buffer window
      const slotA = { id: 'overlap-slot-1', status: TimeSlotStatus.AVAILABLE };
      const slotB = { id: 'overlap-slot-2', status: TimeSlotStatus.AVAILABLE };
      slotRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder([slotA, slotB], 2),
      );

      await service.createBooking(actorUserId, dto);

      expect(slotRepo.update).toHaveBeenCalledWith(
        { id: In(['overlap-slot-1', 'overlap-slot-2']) },
        expect.objectContaining({
          status: TimeSlotStatus.BLOCKED,
          blockedByBookingId: expect.any(String),
        }),
      );
    });

    it('does not call slotRepo.update when no sub-slots are in the blocking window', async () => {
      // default: mockQueryBuilder returns []
      await service.createBooking(actorUserId, dto);

      expect(slotRepo.update).not.toHaveBeenCalled();
    });

    it('releases blocked sub-slots when actor cancels', async () => {
      const sessionStartUtc = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const booking = {
        id: bookingId,
        actorUserId,
        readerUserId,
        readerProfileId,
        timeSlotId,
        status: BookingStatus.CONFIRMED,
        priceCents: 10000,
        sessionStartUtc,
        sessionEndUtc: new Date(sessionStartUtc.getTime() + 60 * 60 * 1000),
        sessionDurationMinutes: 60,
      };
      bookingRepo.findOne.mockResolvedValue(booking);
      profileRepo.findOne.mockResolvedValue({
        id: readerProfileId,
        cancellationPolicy: 'flexible',
      });
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      await service.cancelByActor(bookingId, actorUserId);

      expect(slotRepo.update).toHaveBeenCalledWith(
        { blockedByBookingId: bookingId },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );
    });

    it('releases blocked sub-slots when reader cancels', async () => {
      const sessionStartUtc = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const booking = {
        id: bookingId,
        actorUserId,
        readerUserId,
        readerProfileId,
        timeSlotId,
        status: BookingStatus.CONFIRMED,
        priceCents: 10000,
        sessionStartUtc,
        sessionEndUtc: new Date(sessionStartUtc.getTime() + 60 * 60 * 1000),
        sessionDurationMinutes: 60,
      };
      bookingRepo.findOne.mockResolvedValue(booking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.CONFIRMED,
      });

      await service.cancelByReader(bookingId, readerUserId);

      expect(slotRepo.update).toHaveBeenCalledWith(
        { blockedByBookingId: bookingId },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );
    });

    it('releases blocked sub-slots when payment fails', async () => {
      const booking = {
        id: bookingId,
        timeSlotId,
        status: BookingStatus.HELD,
      };
      bookingRepo.findOne.mockResolvedValue(booking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.HELD,
      });

      await service.handlePaymentFailure(bookingId);

      expect(slotRepo.update).toHaveBeenCalledWith(
        { blockedByBookingId: bookingId },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );
    });

    it('releases blocked sub-slots when hold expires', async () => {
      const expiredBooking = {
        id: bookingId,
        timeSlotId,
        status: BookingStatus.HELD,
        createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago (past 10-min payment window)
      };
      const qb = mockQueryBuilder([expiredBooking], 1);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.HELD,
      });

      await service.cleanupExpiredHolds();

      expect(slotRepo.update).toHaveBeenCalledWith(
        { blockedByBookingId: bookingId },
        { status: TimeSlotStatus.AVAILABLE, blockedByBookingId: null },
      );
    });
  });

  // ─── confirmBooking ─────────────────────────────────────────────────

  describe('confirmBooking', () => {
    it('should set booking and slot to CONFIRMED', async () => {
      const sessionStartUtc = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const heldBooking = {
        id: bookingId,
        status: BookingStatus.HELD,
        timeSlotId,
        actorUserId,
        readerUserId,
        sessionStartUtc,
        sessionEndUtc: new Date(sessionStartUtc.getTime() + 60 * 60 * 1000),
        sessionDurationMinutes: 60,
      };
      bookingRepo.findOne.mockResolvedValue(heldBooking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.HELD,
      });
      slotRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));

      const result = await service.confirmBooking(bookingId);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TimeSlotStatus.CONFIRMED }),
      );
      expect(bookedRehearsalService.ensureForBooking).toHaveBeenCalled();
    });

    it('should release Redis lock', async () => {
      const sessionStartUtc = new Date(Date.now() + 48 * 60 * 60 * 1000);
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.HELD,
        timeSlotId,
        actorUserId,
        readerUserId,
        sessionStartUtc,
        sessionEndUtc: new Date(sessionStartUtc.getTime() + 60 * 60 * 1000),
        sessionDurationMinutes: 60,
      });
      slotRepo.findOne.mockResolvedValue({ id: timeSlotId });
      slotRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));

      await service.confirmBooking(bookingId);

      expect(mockRedisLockService.releaseLock).toHaveBeenCalledWith(
        `booking:slot:${timeSlotId}`,
        '',
      );
    });

    it('should reject if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(service.confirmBooking(bookingId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reset sessionStartUtc to now for INSTANT bookings on confirm', async () => {
      const staleStart = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago (card entry delay)
      const heldBooking = {
        id: bookingId,
        status: BookingStatus.HELD,
        bookingType: BookingType.INSTANT,
        timeSlotId: null,
        actorUserId,
        readerUserId,
        sessionStartUtc: staleStart,
        sessionEndUtc: new Date(staleStart.getTime() + 30 * 60 * 1000),
        sessionDurationMinutes: 30,
      };
      bookingRepo.findOne.mockResolvedValue(heldBooking);
      slotRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));

      const before = Date.now();
      const result = await service.confirmBooking(bookingId);
      const after = Date.now();

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(result.sessionStartUtc.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.sessionStartUtc.getTime()).toBeLessThanOrEqual(after);
      expect(
        result.sessionEndUtc.getTime() - result.sessionStartUtc.getTime(),
      ).toBe(30 * 60 * 1000);
    });

    it('should NOT reset sessionStartUtc for scheduled bookings on confirm', async () => {
      const scheduledStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const scheduledEnd = new Date(scheduledStart.getTime() + 60 * 60 * 1000);
      const heldBooking = {
        id: bookingId,
        status: BookingStatus.HELD,
        bookingType: BookingType.SCHEDULED,
        timeSlotId,
        actorUserId,
        readerUserId,
        sessionStartUtc: scheduledStart,
        sessionEndUtc: scheduledEnd,
        sessionDurationMinutes: 60,
      };
      bookingRepo.findOne.mockResolvedValue(heldBooking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.HELD,
      });
      slotRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([], 0));

      const result = await service.confirmBooking(bookingId);

      expect(result.sessionStartUtc).toEqual(scheduledStart);
      expect(result.sessionEndUtc).toEqual(scheduledEnd);
    });

    it('should reconcile already confirmed bookings without throwing', async () => {
      bookingRepo.findOne.mockResolvedValue({
        id: bookingId,
        status: BookingStatus.CONFIRMED,
        timeSlotId,
        actorUserId,
        readerUserId,
      });
      slotRepo.findOne.mockResolvedValue({ id: timeSlotId });

      await expect(service.confirmBooking(bookingId)).resolves.toMatchObject({
        id: bookingId,
        status: BookingStatus.CONFIRMED,
      });
      expect(bookedRehearsalService.ensureForBooking).toHaveBeenCalled();
    });
  });

  // ─── handlePaymentFailure ───────────────────────────────────────────

  describe('handlePaymentFailure', () => {
    it('should cancel booking and release slot to AVAILABLE', async () => {
      const booking: any = {
        id: bookingId,
        status: BookingStatus.HELD,
        timeSlotId,
      };
      bookingRepo.findOne.mockResolvedValue(booking);
      slotRepo.findOne.mockResolvedValue({
        id: timeSlotId,
        status: TimeSlotStatus.HELD,
      });

      await service.handlePaymentFailure(bookingId);

      expect(booking.status).toBe(BookingStatus.CANCELLED);
      expect(booking.cancellationReason).toBe('Payment failed');
      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TimeSlotStatus.AVAILABLE,
          bookingId: null,
        }),
      );
    });

    it('should do nothing if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(
        service.handlePaymentFailure(bookingId),
      ).resolves.not.toThrow();
      expect(slotRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── getBooking ─────────────────────────────────────────────────────

  describe('getBooking', () => {
    const booking = {
      id: bookingId,
      actorUserId,
      readerUserId,
      readerProfileId,
    };

    it('should return booking for the actor', async () => {
      bookingRepo.findOne.mockResolvedValue(booking);
      paymentRecordRepo.findOne.mockResolvedValue({
        bookingId,
        status: 'succeeded',
        refundStatus: null,
        reversalStatus: null,
        refundedAt: null,
        refundMetaData: null,
      });
      userRepo.find.mockResolvedValue([
        { id: actorUserId, fullName: 'Actor User', avatar: 'actor.jpg' },
        { id: readerUserId, fullName: 'Reader User', avatar: 'reader.jpg' },
      ]);
      specialtyRepo.find.mockResolvedValue([
        { readerProfileId, genre: 'Drama' },
      ]);

      const result = await service.getBooking(bookingId, actorUserId);
      expect(result.data.id).toBe(bookingId);
      expect(result.data.actor.name).toBe('Actor User');
      expect(result.data.reader.genres).toEqual(['Drama']);
      expect(result.data.financialState.paymentStatus).toBe('succeeded');
    });

    it('should return booking for the reader', async () => {
      bookingRepo.findOne.mockResolvedValue(booking);
      paymentRecordRepo.findOne.mockResolvedValue(null);

      const result = await service.getBooking(bookingId, readerUserId);
      expect(result.data.id).toBe(bookingId);
      expect(result.data.financialState.paymentStatus).toBeNull();
    });

    it('should lazily backfill rehearsal summary for non-held bookings', async () => {
      const confirmedBooking = {
        ...booking,
        status: BookingStatus.CONFIRMED,
        timeSlotId,
        sessionDurationMinutes: 30,
        priceCents: 5000,
        currency: 'USD',
        platformFeeCents: 750,
        sessionStartUtc: new Date('2026-03-20T14:00:00.000Z'),
        sessionEndUtc: new Date('2026-03-20T14:30:00.000Z'),
        createdAt: new Date('2026-03-13T08:55:00.000Z'),
        updatedAt: new Date('2026-03-13T08:55:00.000Z'),
      };
      bookingRepo.findOne.mockResolvedValue(confirmedBooking);
      paymentRecordRepo.findOne.mockResolvedValue(null);
      bookedRehearsalService.findManyByBookingIds!.mockResolvedValue([]);
      bookedRehearsalService.ensureForBooking!.mockResolvedValue({
        id: 'reh-1',
        bookingId,
        status: 'CREATED',
        mode: 'READER_BOOKED',
        runtimeEngine: 'STUDIO',
      } as any);

      const result = await service.getBooking(bookingId, actorUserId);

      expect(bookedRehearsalService.ensureForBooking).toHaveBeenCalledWith(
        expect.objectContaining({
          id: bookingId,
          status: BookingStatus.CONFIRMED,
        }),
      );
      expect(result.data.rehearsal).toEqual({
        id: 'reh-1',
        status: 'CREATED',
        mode: 'READER_BOOKED',
        runtimeEngine: 'STUDIO',
      });
    });

    it('should reject if user is neither actor nor reader', async () => {
      bookingRepo.findOne.mockResolvedValue(booking);

      await expect(
        service.getBooking(bookingId, 'random-user'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(service.getBooking(bookingId, actorUserId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── listBookings ───────────────────────────────────────────────────

  describe('listBookings', () => {
    it('should filter by actor role', async () => {
      const qb = mockQueryBuilder(
        [
          {
            id: 'b1',
            actorUserId,
            readerUserId,
            readerProfileId,
          },
        ],
        1,
      );
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      paymentRecordRepo.find.mockResolvedValue([
        {
          bookingId: 'b1',
          status: 'succeeded',
          refundStatus: null,
          reversalStatus: null,
          refundedAt: null,
          refundMetaData: null,
        },
      ]);
      userRepo.find.mockResolvedValue([
        { id: actorUserId, fullName: 'Actor User', avatar: 'actor.jpg' },
        { id: readerUserId, fullName: 'Reader User', avatar: 'reader.jpg' },
      ]);
      specialtyRepo.find.mockResolvedValue([
        { readerProfileId, genre: 'Drama' },
      ]);

      const result = await service.listBookings(actorUserId, { role: 'actor' });

      expect(qb.where).toHaveBeenCalledWith('booking.actorUserId = :userId', {
        userId: actorUserId,
      });
      expect(result.data.items).toHaveLength(1);
      expect(result.data.total).toBe(1);
      expect(result.data.items[0].actor.name).toBe('Actor User');
      expect(result.data.items[0].reader.genres).toEqual(['Drama']);
      expect(result.data.items[0].financialState.paymentStatus).toBe(
        'succeeded',
      );
    });

    it('should filter by reader role', async () => {
      const qb = mockQueryBuilder([], 0);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      paymentRecordRepo.find.mockResolvedValue([]);

      await service.listBookings(readerUserId, { role: 'reader' });

      expect(qb.where).toHaveBeenCalledWith('booking.readerUserId = :userId', {
        userId: readerUserId,
      });
    });

    it('should filter by both roles when no role specified', async () => {
      const qb = mockQueryBuilder([], 0);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      paymentRecordRepo.find.mockResolvedValue([]);

      await service.listBookings(actorUserId);

      expect(qb.where).toHaveBeenCalledWith(
        '(booking.actorUserId = :userId OR booking.readerUserId = :userId)',
        { userId: actorUserId },
      );
    });

    it('should filter by status when provided', async () => {
      const qb = mockQueryBuilder([], 0);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      paymentRecordRepo.find.mockResolvedValue([]);

      await service.listBookings(actorUserId, { status: 'confirmed' });

      expect(qb.andWhere).toHaveBeenCalledWith('booking.status = :status', {
        status: 'confirmed',
      });
    });

    it('should return correct pagination metadata', async () => {
      const qb = mockQueryBuilder([{ id: 'b1' }], 25);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      paymentRecordRepo.find.mockResolvedValue([]);

      const result = await service.listBookings(actorUserId, {
        page: 1,
        limit: 10,
      });

      expect(result.data.total).toBe(25);
      expect(result.data.totalPages).toBe(3);
      expect(result.data.hasNext).toBe(true);
      expect(result.data.hasPrev).toBe(false);
    });

    it('should not backfill rehearsals for held bookings', async () => {
      const heldBooking = {
        id: 'b1',
        actorUserId,
        readerUserId,
        readerProfileId,
        timeSlotId,
        status: BookingStatus.HELD,
        sessionDurationMinutes: 30,
        priceCents: 5000,
        currency: 'USD',
        platformFeeCents: 750,
        sessionStartUtc: new Date('2026-03-20T14:00:00.000Z'),
        sessionEndUtc: new Date('2026-03-20T14:30:00.000Z'),
        createdAt: new Date('2026-03-13T08:55:00.000Z'),
        updatedAt: new Date('2026-03-13T08:55:00.000Z'),
      };
      const qb = mockQueryBuilder([heldBooking], 1);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      paymentRecordRepo.find.mockResolvedValue([]);

      const result = await service.listBookings(actorUserId, { role: 'actor' });

      expect(
        bookedRehearsalService.findManyByBookingIds,
      ).not.toHaveBeenCalled();
      expect(bookedRehearsalService.ensureForBooking).not.toHaveBeenCalled();
      expect(result.data.items[0].rehearsal).toBeNull();
    });
  });

  // ─── cleanupExpiredHolds ────────────────────────────────────────────

  describe('cleanupExpiredHolds', () => {
    it('should cancel held bookings past the payment window', async () => {
      const expiredBooking = {
        id: 'expired-1',
        status: BookingStatus.HELD,
        timeSlotId: 'slot-expired',
        createdAt: new Date(Date.now() - 700000), // ~11 min ago (past 10 min window)
      };

      const qb = mockQueryBuilder([expiredBooking]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);
      slotRepo.findOne.mockResolvedValue({
        id: 'slot-expired',
        status: TimeSlotStatus.HELD,
      });

      const count = await service.cleanupExpiredHolds();

      expect(count).toBe(1);
      expect(expiredBooking.status).toBe(BookingStatus.CANCELLED);
      expect(slotRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TimeSlotStatus.AVAILABLE,
          bookingId: null,
        }),
      );
    });

    it('should return 0 when no expired holds exist', async () => {
      const qb = mockQueryBuilder([]);
      bookingRepo.createQueryBuilder.mockReturnValue(qb);

      const count = await service.cleanupExpiredHolds();

      expect(count).toBe(0);
    });
  });
});
