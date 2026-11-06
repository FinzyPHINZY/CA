/** biome-ignore-all lint/style/useImportType: <> */

import {
  Booking,
  BookingStatus,
  BookingType,
  NOTIFICATIONS_SERVICE,
  ReaderProfile,
  ReaderSessionRate,
  RedisLockService,
  User,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, In } from 'typeorm';
import { FeeCalculationService } from './fee-calculation.service';
import { InstantConnectDto } from './dto/instant-connect.dto';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

const INSTANT_CONNECT_TTL_SECONDS = 90;
const READER_LOCK_TTL_SECONDS = 90;

@Injectable()
export class InstantConnectService {
  private readonly logger = new Logger(InstantConnectService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisLockService: RedisLockService,
    private readonly feeCalculationService: FeeCalculationService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async requestInstantConnect(actorUserId: string, dto: InstantConnectDto) {
    const { readerProfileId, sessionDurationMinutes } = dto;

    // Load reader profile
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { id: readerProfileId, isAcceptingBookings: true },
    });
    if (!profile) {
      throw new NotFoundException(
        'Reader profile not found or not accepting bookings',
      );
    }

    // Reader must be online (check Redis presence, same source of truth as reader discovery)
    const isOnline = await this.redisLockService.exists(
      `reader:online:${profile.userId}`,
    );
    if (!isOnline) {
      throw new BadRequestException('Reader is not currently online');
    }

    // Can't connect with yourself
    if (profile.userId === actorUserId) {
      throw new BadRequestException('Cannot connect with yourself');
    }

    // Check reader is not busy (in-progress or already has a pending request)
    const bookingRepo = this.dataSource.getRepository(Booking);
    const busyCount = await bookingRepo.count({
      where: {
        readerUserId: profile.userId,
        status: In([
          BookingStatus.IN_PROGRESS,
          BookingStatus.PENDING_ACCEPTANCE,
        ]),
      },
    });
    if (busyCount > 0) {
      throw new ConflictException('Reader is currently busy');
    }

    // Find matching session rate
    const rateRepo = this.dataSource.getRepository(ReaderSessionRate);
    const rate = await rateRepo.findOne({
      where: { readerProfileId, durationMinutes: sessionDurationMinutes },
    });
    if (!rate) {
      throw new BadRequestException(
        `Reader does not offer ${sessionDurationMinutes}-minute sessions`,
      );
    }

    // Acquire lock on reader to prevent concurrent instant connect requests
    const lockResult = await this.redisLockService.acquireLock(
      `instant-connect:reader:${profile.userId}`,
      READER_LOCK_TTL_SECONDS,
    );
    if (!lockResult.acquired) {
      throw new ConflictException(
        'Another actor is already requesting this reader. Please try again.',
      );
    }

    try {
      const fees = this.feeCalculationService.calculate(rate.priceCents);
      const now = new Date();
      const sessionEndUtc = new Date(
        now.getTime() + sessionDurationMinutes * 60_000,
      );
      const expiresAt = new Date(
        now.getTime() + INSTANT_CONNECT_TTL_SECONDS * 1000,
      );

      // Create booking
      const booking = await this.dataSource.transaction(async (manager) => {
        const newBooking = manager.getRepository(Booking).create({
          actorUserId,
          readerUserId: profile.userId,
          readerProfileId,
          timeSlotId: undefined,
          status: BookingStatus.PENDING_ACCEPTANCE,
          bookingType: BookingType.INSTANT,
          sessionDurationMinutes,
          priceCents: rate.priceCents,
          currency: 'USD',
          platformFeeCents: fees.platformFeeCents,
          sessionStartUtc: now,
          sessionEndUtc,
        });
        return manager.getRepository(Booking).save(newBooking);
      });

      // Store request in Redis for timeout detection
      await this.redis.set(
        `instant-connect:${booking.id}`,
        JSON.stringify({
          actorUserId,
          readerUserId: profile.userId,
          lockToken: lockResult.lockToken,
        }),
        'EX',
        INSTANT_CONNECT_TTL_SECONDS,
      );

      // Fetch actor info for notification payload
      const actorUser = await this.dataSource.getRepository(User).findOne({
        where: { id: actorUserId },
        select: ['id', 'fullName', 'avatar'],
      });

      // Emit to notifications service → WebSocket to reader
      this.notificationsClient.emit('instant-connect.request', {
        bookingId: booking.id,
        actorUserId,
        actorName: actorUser?.fullName ?? null,
        actorAvatar: actorUser?.avatar ?? null,
        readerUserId: profile.userId,
        sessionDurationMinutes,
        priceCents: rate.priceCents,
        currency: 'USD',
        expiresAt: expiresAt.toISOString(),
      });

      this.logger.log(
        `Instant connect request created: booking ${booking.id} from ${actorUserId} to reader ${profile.userId}`,
      );

      return {
        booking: {
          ...booking,
          actor: {
            name: actorUser?.fullName ?? null,
            avatar: actorUser?.avatar ?? null,
          },
        },
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      // Release lock on failure
      await this.redisLockService.releaseLock(
        `instant-connect:reader:${profile.userId}`,
        lockResult.lockToken,
      );
      throw error;
    }
  }

  async acceptInstantConnect(bookingId: string, readerUserId: string) {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const booking = await bookingRepo.findOne({ where: { id: bookingId } });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== BookingStatus.PENDING_ACCEPTANCE) {
      throw new ConflictException(
        'This request is no longer pending acceptance',
      );
    }
    if (booking.readerUserId !== readerUserId) {
      throw new BadRequestException('You are not the reader for this booking');
    }

    // Check Redis key still exists (not timed out)
    const requestData = await this.redis.get(`instant-connect:${bookingId}`);
    if (!requestData) {
      // Request already expired — cancel the booking
      await bookingRepo.update(bookingId, {
        status: BookingStatus.CANCELLED,
        cancellationReason: 'Request timed out',
        cancelledAt: new Date(),
      });
      throw new ConflictException('This request has expired');
    }

    const parsed = JSON.parse(requestData);

    // Reset session times to now (acceptance moment)
    const now = new Date();
    const sessionEndUtc = new Date(
      now.getTime() + booking.sessionDurationMinutes * 60_000,
    );

    await bookingRepo.update(bookingId, {
      status: BookingStatus.HELD,
      sessionStartUtc: now,
      sessionEndUtc,
    });

    // Clean up Redis
    await this.redis.del(`instant-connect:${bookingId}`);
    await this.redisLockService.releaseLock(
      `instant-connect:reader:${readerUserId}`,
      parsed.lockToken,
    );

    // Fetch names for notification
    const [actorUser, readerUser] = await Promise.all([
      this.dataSource.getRepository(User).findOne({
        where: { id: booking.actorUserId },
        select: ['id', 'fullName', 'avatar'],
      }),
      this.dataSource.getRepository(User).findOne({
        where: { id: readerUserId },
        select: ['id', 'fullName', 'avatar'],
      }),
    ]);

    // Notify actor: reader accepted, proceed to payment
    this.notificationsClient.emit('instant-connect.accepted', {
      bookingId,
      actorUserId: booking.actorUserId,
      readerUserId,
      readerName: readerUser?.fullName ?? null,
      readerAvatar: readerUser?.avatar ?? null,
      sessionDurationMinutes: booking.sessionDurationMinutes,
      priceCents: booking.priceCents,
      currency: booking.currency,
    });

    this.logger.log(
      `Instant connect accepted: booking ${bookingId} by reader ${readerUserId}`,
    );

    const updatedBooking = await bookingRepo.findOne({
      where: { id: bookingId },
    });

    return {
      booking: {
        ...updatedBooking,
        actor: {
          name: actorUser?.fullName ?? null,
          avatar: actorUser?.avatar ?? null,
        },
        reader: {
          name: readerUser?.fullName ?? null,
          avatar: readerUser?.avatar ?? null,
        },
      },
    };
  }

  async declineInstantConnect(
    bookingId: string,
    readerUserId: string,
    reason?: string,
  ) {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const booking = await bookingRepo.findOne({ where: { id: bookingId } });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.status !== BookingStatus.PENDING_ACCEPTANCE) {
      throw new ConflictException(
        'This request is no longer pending acceptance',
      );
    }
    if (booking.readerUserId !== readerUserId) {
      throw new BadRequestException('You are not the reader for this booking');
    }

    await bookingRepo.update(bookingId, {
      status: BookingStatus.CANCELLED,
      cancellationReason: reason || 'Declined by reader',
      cancelledBy: 'reader',
      cancelledAt: new Date(),
    });

    // Clean up Redis
    const requestData = await this.redis.get(`instant-connect:${bookingId}`);
    if (requestData) {
      const parsed = JSON.parse(requestData);
      await this.redis.del(`instant-connect:${bookingId}`);
      await this.redisLockService.releaseLock(
        `instant-connect:reader:${readerUserId}`,
        parsed.lockToken,
      );
    }

    // Notify actor
    this.notificationsClient.emit('instant-connect.declined', {
      bookingId,
      actorUserId: booking.actorUserId,
      readerUserId,
      reason: reason || 'Declined by reader',
    });

    this.logger.log(
      `Instant connect declined: booking ${bookingId} by reader ${readerUserId}`,
    );

    return { success: true };
  }

  /**
   * Called by cron to cancel expired PENDING_ACCEPTANCE instant bookings.
   */
  async cleanupExpiredRequests(): Promise<number> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const cutoff = new Date(Date.now() - INSTANT_CONNECT_TTL_SECONDS * 1000);

    const expired = await bookingRepo.find({
      where: {
        status: BookingStatus.PENDING_ACCEPTANCE,
        bookingType: BookingType.INSTANT,
      },
    });

    // Filter in JS since TypeORM doesn't have a clean "createdAt < cutoff" builder with enums
    const toCancel = expired.filter(
      (b) => b.createdAt && new Date(b.createdAt) < cutoff,
    );

    for (const booking of toCancel) {
      await bookingRepo.update(booking.id, {
        status: BookingStatus.CANCELLED,
        cancellationReason: 'Request timed out',
        cancelledAt: new Date(),
      });

      // Clean up Redis
      const requestData = await this.redis.get(`instant-connect:${booking.id}`);
      if (requestData) {
        const parsed = JSON.parse(requestData);
        await this.redis.del(`instant-connect:${booking.id}`);
        await this.redisLockService.releaseLock(
          `instant-connect:reader:${booking.readerUserId}`,
          parsed.lockToken,
        );
      }

      // Notify both parties
      this.notificationsClient.emit('instant-connect.timeout', {
        bookingId: booking.id,
        actorUserId: booking.actorUserId,
        readerUserId: booking.readerUserId,
      });

      this.logger.log(`Instant connect timed out: booking ${booking.id}`);
    }

    return toCancel.length;
  }
}
