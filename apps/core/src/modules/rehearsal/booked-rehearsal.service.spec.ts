/** biome-ignore-all lint/suspicious/noExplicitAny: test doubles are partial */
import {
  Booking,
  BookingStatus,
  RehearsalEventType,
  RehearsalStatus,
  Rehersal,
  RehersalRepository,
} from '@app/common';
import { DataSource } from 'typeorm';
import { BookedRehearsalService } from './booked-rehearsal.service';
import { RehearsalLifecycleEventService } from './rehearsal-lifecycle-event.service';

function makeRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn(async (entity) => ({
      id: entity.id ?? 'reh-1',
      createdAt: entity.createdAt ?? new Date('2026-03-13T08:55:00.000Z'),
      updatedAt: new Date('2026-03-13T08:55:00.000Z'),
      ...entity,
    })),
    update: jest.fn(),
  };
}

describe('BookedRehearsalService', () => {
  let service: BookedRehearsalService;
  let dataSource: DataSource;
  let rehearsalRepo: ReturnType<typeof makeRepository>;
  let rehersalRepository: Partial<RehersalRepository>;
  let lifecycleEventService: Partial<RehearsalLifecycleEventService>;

  beforeEach(() => {
    rehearsalRepo = makeRepository();
    dataSource = {
      getRepository: jest.fn(() => rehearsalRepo),
    } as unknown as DataSource;
    rehersalRepository = {
      findByBookingId: jest.fn(),
      updateById: jest.fn(),
    };
    lifecycleEventService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new BookedRehearsalService(
      dataSource,
      rehersalRepository as unknown as RehersalRepository,
      lifecycleEventService as unknown as RehearsalLifecycleEventService,
    );
  });

  it('should infer COMPLETED state when lazily backfilling a completed booking', async () => {
    const booking = {
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
      readerProfileId: 'profile-1',
      status: BookingStatus.COMPLETED,
      sessionDurationMinutes: 30,
      sessionStartUtc: new Date('2026-03-20T14:00:00.000Z'),
      sessionEndUtc: new Date('2026-03-20T14:30:00.000Z'),
      completedAt: new Date('2026-03-20T14:25:00.000Z'),
    } as Booking;

    rehearsalRepo.findOne.mockResolvedValue(null);

    const result = await service.ensureForBooking(booking);

    expect(result.status).toBe(RehearsalStatus.COMPLETED);
    expect(result.startedAt).toEqual(booking.sessionStartUtc);
    expect(result.endedAt).toEqual(booking.completedAt);
    expect(result.sessionDurationSeconds).toBe(1500);
    expect(lifecycleEventService.log).toHaveBeenNthCalledWith(
      1,
      'reh-1',
      RehearsalEventType.SESSION_CREATED,
      expect.objectContaining({
        data: expect.objectContaining({ bookingId: booking.id }),
      }),
    );
    expect(lifecycleEventService.log).toHaveBeenNthCalledWith(
      2,
      'reh-1',
      RehearsalEventType.SESSION_STARTED,
      expect.objectContaining({
        data: expect.objectContaining({ backfilled: true }),
      }),
    );
    expect(lifecycleEventService.log).toHaveBeenNthCalledWith(
      3,
      'reh-1',
      RehearsalEventType.SESSION_COMPLETED,
      expect.objectContaining({
        data: expect.objectContaining({ backfilled: true }),
      }),
    );
  });

  it('should synchronize existing booking-backed rehearsal state for in-progress bookings', async () => {
    const booking = {
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
      readerProfileId: 'profile-1',
      status: BookingStatus.IN_PROGRESS,
      sessionDurationMinutes: 30,
      sessionStartUtc: new Date('2026-03-20T14:00:00.000Z'),
      sessionEndUtc: new Date('2026-03-20T14:30:00.000Z'),
    } as Booking;
    const existing = {
      id: 'reh-existing',
      bookingId: booking.id,
      userId: booking.actorUserId,
      rehearsalPartnerUserId: booking.readerUserId,
      mode: 'READER_BOOKED',
      runtimeEngine: 'STUDIO',
      status: RehearsalStatus.CREATED,
      startedAt: null,
      endedAt: null,
      sessionDurationSeconds: null,
      metaData: null,
    } as unknown as Rehersal;

    rehearsalRepo.findOne.mockResolvedValue(existing);
    rehearsalRepo.save.mockImplementation(async (entity) => entity);

    const result = await service.ensureForBooking(booking);

    expect(result.status).toBe(RehearsalStatus.ACTIVE);
    expect(result.startedAt).toEqual(booking.sessionStartUtc);
    expect(result.runtimeEngine).toBe('STUDIO');
    expect(lifecycleEventService.log).not.toHaveBeenCalled();
  });
});
