/** biome-ignore-all lint/suspicious/noExplicitAny: test doubles are partial */
import {
  BookingStatus,
  BookingRepository,
  NOTIFICATIONS_SERVICE,
} from '@app/common';
import { AgoraSessionStatus } from '@app/common/enums/studio.enum';
import { DataSource } from 'typeorm';
import { BookedRehearsalService } from '../rehearsal/booked-rehearsal.service';
import { AgoraChannelService } from './agora-channel.service';
import { AgoraSessionRepository } from '@app/common';
import { AgoraTokenService } from './agora-token.service';
import { SessionService } from './session.service';
import { StudioRecordingService } from './studio-recording.service';

describe('SessionService', () => {
  let service: SessionService;
  let bookingRepository: Partial<BookingRepository>;
  let agoraSessionRepository: Partial<AgoraSessionRepository>;
  let agoraChannelService: Partial<AgoraChannelService>;
  let agoraTokenService: Partial<AgoraTokenService>;
  let studioRecordingService: Partial<StudioRecordingService>;
  let bookedRehearsalService: Partial<BookedRehearsalService>;
  let notificationsClient: { emit: jest.Mock };

  beforeEach(() => {
    bookingRepository = {
      findById: jest.fn(),
      updateById: jest.fn(),
    };
    agoraSessionRepository = {
      findByBookingId: jest.fn(),
      updateById: jest.fn(),
    };
    agoraChannelService = {
      createChannel: jest.fn(),
      joinChannel: jest.fn(),
    };
    agoraTokenService = {};
    studioRecordingService = {
      stopRecording: jest.fn(),
    };
    bookedRehearsalService = {
      ensureForBooking: jest.fn(),
      markActive: jest.fn(),
      markCompleted: jest.fn(),
    };
    notificationsClient = {
      emit: jest.fn(),
    };

    service = new SessionService(
      bookingRepository as unknown as BookingRepository,
      agoraSessionRepository as unknown as AgoraSessionRepository,
      agoraChannelService as unknown as AgoraChannelService,
      agoraTokenService as unknown as AgoraTokenService,
      studioRecordingService as unknown as StudioRecordingService,
      { transaction: jest.fn() } as unknown as DataSource,
      bookedRehearsalService as unknown as BookedRehearsalService,
      { findByBookingId: jest.fn().mockResolvedValue(null) } as any,
      { markAllDeletedOnSessionEnd: jest.fn().mockResolvedValue(0) } as any,
      notificationsClient as any,
    );
  });

  it('should synchronize rehearsal activation when a booked studio session starts', async () => {
    const booking = {
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
      status: BookingStatus.CONFIRMED,
      sessionStartUtc: new Date(Date.now() - 5 * 60 * 1000),
      sessionEndUtc: new Date(Date.now() + 25 * 60 * 1000),
    };
    const rehearsal = { id: 'reh-1' };
    const startedAt = new Date('2026-03-20T14:02:00.000Z');

    (bookingRepository.findById as jest.Mock).mockResolvedValue(booking as any);
    (bookedRehearsalService.ensureForBooking as jest.Mock).mockResolvedValue(
      rehearsal as any,
    );
    (agoraSessionRepository.findByBookingId as jest.Mock).mockResolvedValue(
      null,
    );
    (agoraChannelService.createChannel as jest.Mock).mockResolvedValue({
      id: 'session-1',
      channelName: 'session_booking-1',
    } as any);
    (agoraChannelService.joinChannel as jest.Mock).mockResolvedValue({
      session: {
        id: 'session-1',
        channelName: 'session_booking-1',
        startedAt,
      },
      tokenResult: {
        token: 'rtc-token',
        uid: 1,
        appId: 'agora-app',
        channelName: 'session_booking-1',
      },
    } as any);

    const result = await service.startSession('booking-1', 'actor-1');

    expect(bookedRehearsalService.ensureForBooking).toHaveBeenCalledWith(
      booking,
    );
    expect(agoraChannelService.createChannel).toHaveBeenCalledWith('actor-1', {
      bookingId: 'booking-1',
      rehearsalId: 'reh-1',
    });
    expect(bookedRehearsalService.markActive).toHaveBeenCalledWith(
      booking,
      startedAt,
    );
    expect(result.data.booking.status).toBe(BookingStatus.IN_PROGRESS);
  });

  it('should synchronize rehearsal completion when a booked studio session ends', async () => {
    const booking = {
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
      status: BookingStatus.IN_PROGRESS,
      sessionStartUtc: new Date(Date.now() - 20 * 60 * 1000),
      sessionEndUtc: new Date(Date.now() + 10 * 60 * 1000),
    };
    const completedBooking = {
      ...booking,
      status: BookingStatus.COMPLETED,
      completedAt: new Date('2026-03-20T14:30:00.000Z'),
    };

    (bookingRepository.findById as jest.Mock).mockResolvedValue(booking as any);
    (bookedRehearsalService.ensureForBooking as jest.Mock).mockResolvedValue({
      id: 'reh-1',
    } as any);
    (agoraSessionRepository.findByBookingId as jest.Mock).mockResolvedValue({
      id: 'session-1',
      status: AgoraSessionStatus.ACTIVE,
      channelName: 'session_booking-1',
      agoraResourceId: null,
      agoraSid: null,
    } as any);
    (service as any).completeBookingTransaction = jest
      .fn()
      .mockResolvedValue(completedBooking);

    const result = await service.completeSession('booking-1', 'actor-1');

    expect(agoraSessionRepository.updateById).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        status: AgoraSessionStatus.ENDED,
      }),
    );
    expect(bookedRehearsalService.markCompleted).toHaveBeenCalledWith(
      completedBooking,
    );
    expect(result.data.booking.status).toBe(BookingStatus.COMPLETED);
  });
});
