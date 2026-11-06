/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  AgoraSession,
  AgoraSessionRepository,
  Booking,
  BookingRepository,
  BookingStatus,
  BookingType,
  NOTIFICATIONS_SERVICE,
  PaymentRecord,
  RehersalRepository,
  SETTLEMENT_DELAY_HOURS,
} from '@app/common';
import { AgoraSessionStatus } from '@app/common/enums/studio.enum';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { BookedRehearsalService } from '../rehearsal/booked-rehearsal.service';
import { AgoraChannelService } from './agora-channel.service';
import { AgoraTokenService, RtcTokenResult } from './agora-token.service';
import { SessionFilesService } from './session-files.service';
import { StudioRecordingService } from './studio-recording.service';

// Users can join up to 30 minutes before the scheduled session start.
const SESSION_OPEN_WINDOW_MINUTES = 30;

export interface StartSessionResult {
  booking: Booking;
  session: AgoraSession;
  tokenResult: RtcTokenResult;
  role: 'actor' | 'reader';
  channelName: string;
}

export interface SessionStatusResult {
  booking: Booking;
  session: AgoraSession | null;
  isOpen: boolean;
  minutesUntilOpen: number | null;
  minutesRemaining: number | null;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly bookingRepository: BookingRepository,
    private readonly agoraSessionRepository: AgoraSessionRepository,
    private readonly agoraChannelService: AgoraChannelService,
    private readonly agoraTokenService: AgoraTokenService,
    private readonly studioRecordingService: StudioRecordingService,
    private readonly dataSource: DataSource,
    private readonly bookedRehearsalService: BookedRehearsalService,
    private readonly rehearsalRepository: RehersalRepository,
    private readonly sessionFilesService: SessionFilesService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  // Start or rejoin a reader session.
  // Can be called by either the actor or the reader.
  // Creates the Agora channel if the bridge cron hasn't done so yet.
  async startSession(bookingId: string, userId: string): Promise<any> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const isActor = booking.actorUserId === userId;
    const isReader = booking.readerUserId === userId;
    if (!isActor && !isReader) {
      throw new ForbiddenException('You are not a participant in this booking');
    }

    if (
      booking.status !== BookingStatus.CONFIRMED &&
      booking.status !== BookingStatus.IN_PROGRESS
    ) {
      throw new BadRequestException(
        `Cannot start session: booking status is '${booking.status}'. Expected 'confirmed' or 'in_progress'.`,
      );
    }

    // Validate time window (skip for instant connect — session is "now")
    const isInstant = booking.bookingType === BookingType.INSTANT;
    const now = new Date();

    if (!isInstant) {
      const windowOpen = new Date(
        booking.sessionStartUtc.getTime() -
          SESSION_OPEN_WINDOW_MINUTES * 60 * 1000,
      );

      if (now < windowOpen) {
        const minutesUntilOpen = Math.ceil(
          (windowOpen.getTime() - now.getTime()) / 60_000,
        );
        throw new BadRequestException(
          `Session not open yet. Can join ${SESSION_OPEN_WINDOW_MINUTES} minutes before start. Opens in ${minutesUntilOpen} minute(s).`,
        );
      }

      if (now > booking.sessionEndUtc) {
        throw new BadRequestException(
          'Session window has passed. The scheduled session time has ended.',
        );
      }
    }

    const rehearsal =
      await this.bookedRehearsalService.ensureForBooking(booking);

    // Get or create the Agora channel
    // The bridge cron pre-creates it 15 minutes before; fall back to on-demand creation here.
    let agoraSession =
      await this.agoraSessionRepository.findByBookingId(bookingId);

    if (!agoraSession || agoraSession.status === AgoraSessionStatus.ENDED) {
      // always use actorUserId as creator so recordings are attributed to the actor
      // regardless of which participant calls startSession first
      agoraSession = await this.agoraChannelService.createChannel(
        booking.actorUserId,
        {
          bookingId,
          rehearsalId: rehearsal.id,
        },
      );
    } else if (agoraSession.rehearsalId !== rehearsal.id) {
      await this.agoraSessionRepository.updateById(agoraSession.id, {
        rehearsalId: rehearsal.id,
      } as any);
      agoraSession.rehearsalId = rehearsal.id;
    }

    // Join the channel (generates token, sets status to ACTIVE on first join)
    const { session: updatedSession, tokenResult } =
      await this.agoraChannelService.joinChannel(
        userId,
        agoraSession.channelName,
        'publisher',
      );

    // Transition booking from CONFIRMED to IN_PROGRESS on first join
    if (booking.status === BookingStatus.CONFIRMED) {
      await this.bookingRepository.updateById(booking.id, {
        status: BookingStatus.IN_PROGRESS,
      } as any);
      booking.status = BookingStatus.IN_PROGRESS;

      // Notify both participants that the session is live
      this.notificationsClient.emit('session.started', {
        bookingId,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
        channelName: agoraSession.channelName,
        startedBy: userId,
        startedAt: new Date().toISOString(),
      });
    }

    await this.bookedRehearsalService.markActive(
      booking,
      updatedSession.startedAt ?? new Date(),
    );

    this.logger.log(
      `Session started: booking=${bookingId}, user=${userId} (${isActor ? 'actor' : 'reader'}), channel=${agoraSession.channelName}`,
    );

    return {
      success: true,
      message: 'Session started successfully',
      data: {
        booking,
        session: updatedSession,
        tokenResult,
        role: isActor ? 'actor' : 'reader',
        channelName: agoraSession.channelName,
      },
    };
  }

  // Complete a reader session.
  // Stops recording, ends the Agora channel, and marks the booking as COMPLETED.
  // Idempotent — safe to call multiple times.
  async completeSession(bookingId: string, userId: string): Promise<any> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const isParticipant =
      booking.actorUserId === userId || booking.readerUserId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this booking');
    }

    // Idempotent: already completed
    if (booking.status === BookingStatus.COMPLETED) {
      return {
        success: true,
        message: 'Session completed successfully',
        data: { booking, completed: true },
      };
    }

    if (
      booking.status !== BookingStatus.IN_PROGRESS &&
      booking.status !== BookingStatus.CONFIRMED
    ) {
      throw new BadRequestException(
        `Cannot complete session with status '${booking.status}'`,
      );
    }

    await this.bookedRehearsalService.ensureForBooking(booking);

    const agoraSession =
      await this.agoraSessionRepository.findByBookingId(bookingId);

    // Stop cloud recording if active
    if (agoraSession && agoraSession.agoraResourceId && agoraSession.agoraSid) {
      try {
        await this.studioRecordingService.stopRecording(agoraSession);
      } catch (error: any) {
        this.logger.error(
          `Failed to stop recording for session ${bookingId}: ${error.message}`,
        );
      }
    }

    // End the Agora channel
    if (agoraSession && agoraSession.status !== AgoraSessionStatus.ENDED) {
      await this.agoraSessionRepository.updateById(agoraSession.id, {
        status: AgoraSessionStatus.ENDED,
        endedAt: new Date(),
      } as any);
    }

    // Complete the booking (updates booking + slot + reader profile totalSessions)
    const completedBooking = await this.completeBookingTransaction(bookingId);
    await this.bookedRehearsalService.markCompleted(completedBooking);

    // Soft-delete any files shared inside this session. Retention cron
    // hard-deletes (S3 + DB) 24h later — until then, FE refetches see an
    // empty list and the data remains recoverable if a bug is reported.
    try {
      const rehearsal =
        await this.rehearsalRepository.findByBookingId(bookingId);
      if (rehearsal) {
        await this.sessionFilesService.markAllDeletedOnSessionEnd(rehearsal.id);
      }
    } catch (err: any) {
      // Cleanup failure must not block session completion — the cron will
      // pick up unclean rows on its next pass.
      this.logger.error(
        `Failed to soft-delete shared files for booking ${bookingId}: ${err.message}`,
      );
    }

    // Notify both participants
    this.notificationsClient.emit('session.completed', {
      bookingId,
      actorUserId: booking.actorUserId,
      readerUserId: booking.readerUserId,
      completedBy: userId,
      completedAt: new Date().toISOString(),
      channelName: agoraSession?.channelName,
    });

    this.logger.log(`Session completed: booking=${bookingId}, user=${userId}`);

    return {
      success: true,
      message: 'Session completed successfully',
      data: { booking: completedBooking, completed: true },
    };
  }

  // Generate a fresh Agora token for a participant reconnecting after a network drop.
  // The session must still be in IN_PROGRESS status.
  async reconnectSession(bookingId: string, userId: string): Promise<any> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const isParticipant =
      booking.actorUserId === userId || booking.readerUserId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this booking');
    }

    if (booking.status !== BookingStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Session is not active (status: ${booking.status}). Cannot reconnect.`,
      );
    }

    const agoraSession =
      await this.agoraSessionRepository.findByBookingId(bookingId);
    if (!agoraSession || agoraSession.status === AgoraSessionStatus.ENDED) {
      throw new BadRequestException(
        'No active Agora channel found for this booking.',
      );
    }

    const tokenResult = await this.agoraChannelService.refreshToken(
      userId,
      agoraSession.channelName,
      'publisher',
    );

    this.logger.log(
      `Token refreshed for reconnect: booking=${bookingId}, user=${userId}`,
    );

    return {
      success: true,
      message: 'Reconnected successfully',
      data: { tokenResult, channelName: agoraSession.channelName },
    };
  }

  // Get the current status of a booking's session.
  // Returns booking state, Agora session (if exists), and computed time metadata.
  async getSessionStatus(bookingId: string, userId: string): Promise<any> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new NotFoundException(`Booking ${bookingId} not found`);
    }

    const isParticipant =
      booking.actorUserId === userId || booking.readerUserId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this booking');
    }

    const session =
      await this.agoraSessionRepository.findByBookingId(bookingId);

    const now = new Date();
    const windowOpen = new Date(
      booking.sessionStartUtc.getTime() -
        SESSION_OPEN_WINDOW_MINUTES * 60 * 1000,
    );
    const isOpen = now >= windowOpen && now <= booking.sessionEndUtc;
    const minutesUntilOpen =
      now < windowOpen
        ? Math.ceil((windowOpen.getTime() - now.getTime()) / 60_000)
        : null;
    const minutesRemaining =
      now <= booking.sessionEndUtc
        ? Math.ceil((booking.sessionEndUtc.getTime() - now.getTime()) / 60_000)
        : null;

    const MAX_EXTENSIONS = 3;
    const canExtend =
      booking.status === BookingStatus.IN_PROGRESS &&
      booking.extensionAllowed &&
      booking.extensionCount < MAX_EXTENSIONS;

    return {
      success: true,
      message: 'Session status retrieved successfully',
      data: {
        booking,
        session: session || null,
        isOpen,
        minutesUntilOpen,
        minutesRemaining,
        extension: {
          extensionAllowed: booking.extensionAllowed,
          extensionCount: booking.extensionCount,
          maxExtensions: MAX_EXTENSIONS,
          canExtend,
        },
      },
    };
  }

  // Complete booking in a transaction: update booking, time slot, and reader's total sessions counter.
  // For separate-charge payments, transitions to AWAITING_SETTLEMENT instead of COMPLETED.
  private async completeBookingTransaction(
    bookingId: string,
  ): Promise<Booking> {
    return this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const paymentRepo = manager.getRepository(PaymentRecord);

      const booking = await bookingRepo.findOne({ where: { id: bookingId } });
      if (!booking) {
        throw new NotFoundException(`Booking ${bookingId} not found`);
      }

      // Check if this booking uses separate charges
      const payment = await paymentRepo.findOne({ where: { bookingId } });
      const isSeparateCharge = payment?.paymentModel === 'separate';

      if (isSeparateCharge) {
        booking.status = BookingStatus.AWAITING_SETTLEMENT;
        await bookingRepo.save(booking);

        // Mark payment as eligible for settlement after the dispute window
        payment.settlementStatus = 'eligible';
        payment.settlementEligibleAt = new Date(
          Date.now() + SETTLEMENT_DELAY_HOURS * 60 * 60 * 1000,
        );
        await paymentRepo.save(payment);
      } else {
        booking.status = BookingStatus.COMPLETED;
        booking.completedAt = new Date();
        await bookingRepo.save(booking);
      }

      // Mark time slot as completed (only for scheduled bookings)
      if (booking.timeSlotId) {
        await manager.query(
          `UPDATE marketplace_schema.time_slots SET status = 'completed' WHERE id = $1`,
          [booking.timeSlotId],
        );
      }

      // Increment reader's total sessions counter
      await manager.query(
        `UPDATE marketplace_schema.reader_profiles SET "totalSessions" = "totalSessions" + 1 WHERE id = (
           SELECT "readerProfileId" FROM marketplace_schema.bookings WHERE id = $1
         )`,
        [bookingId],
      );

      this.logger.log(
        `Booking ${bookingId} ${isSeparateCharge ? 'awaiting settlement' : 'completed'} via transaction`,
      );
      return booking;
    });
  }
}
