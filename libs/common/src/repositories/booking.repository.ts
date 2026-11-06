import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BookingStatus } from '../enums/marketplace.enum';
import { Booking } from '../entities/booking.entity';
import { Rehersal } from '../entities/rehersal.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class BookingRepository extends BaseRepository<Booking> {
  constructor(dataSource: DataSource) {
    super(Booking, dataSource.manager);
  }

  async findByActorUserId(actorUserId: string): Promise<Booking[]> {
    return this.findManyBy({ actorUserId });
  }

  async findByReaderUserId(readerUserId: string): Promise<Booking[]> {
    return this.findManyBy({ readerUserId });
  }

  async findByStripePaymentIntentId(
    stripePaymentIntentId: string,
  ): Promise<Booking | null> {
    return this.findOneBy({ stripePaymentIntentId });
  }

  async findConfirmedStartingSoon(windowMinutes: number): Promise<Booking[]> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + windowMinutes * 60 * 1000);
    return this.createQueryBuilder('booking')
      .where('booking.status = :status', { status: BookingStatus.CONFIRMED })
      .andWhere('booking.sessionStartUtc >= :now', { now })
      .andWhere('booking.sessionStartUtc <= :windowEnd', { windowEnd })
      .andWhere('booking.deletedAt IS NULL')
      .getMany();
  }

  async findInProgressPastForceEnd(): Promise<Booking[]> {
    const forceEndCutoff = new Date(Date.now() - 10 * 60 * 1000);
    return this.createQueryBuilder('booking')
      .where('booking.status = :status', { status: BookingStatus.IN_PROGRESS })
      .andWhere('booking.sessionEndUtc <= :forceEndCutoff', { forceEndCutoff })
      .andWhere('booking.deletedAt IS NULL')
      .getMany();
  }

  // Returns true if `userId` is the actor OR reader on the booking that backs
  // this rehearsal. Used by SessionFilesService to gate every shared-file call.
  // False for AI rehearsals (no booking) and for unrelated users.
  async isParticipantOfRehearsal(
    rehearsalId: string,
    userId: string,
  ): Promise<boolean> {
    const result = await this.createQueryBuilder('booking')
      .innerJoin(
        Rehersal,
        'rehearsal',
        'rehearsal."bookingId" = booking.id',
      )
      .where('rehearsal.id = :rehearsalId', { rehearsalId })
      .andWhere('rehearsal."deletedAt" IS NULL')
      .andWhere('booking.deletedAt IS NULL')
      .andWhere(
        '(booking.actorUserId = :userId OR booking.readerUserId = :userId)',
        { userId },
      )
      .select('booking.id')
      .limit(1)
      .getRawOne();

    return Boolean(result);
  }

  // Used by SessionFilesService to fan out socket events to both participants.
  // Returns both userIds (actor + reader). Null if rehearsal has no booking.
  async getParticipantUserIds(
    rehearsalId: string,
  ): Promise<{ actorUserId: string; readerUserId: string } | null> {
    const row = await this.createQueryBuilder('booking')
      .innerJoin(
        Rehersal,
        'rehearsal',
        'rehearsal."bookingId" = booking.id',
      )
      .where('rehearsal.id = :rehearsalId', { rehearsalId })
      .andWhere('rehearsal."deletedAt" IS NULL')
      .andWhere('booking.deletedAt IS NULL')
      .select([
        'booking.actorUserId AS "actorUserId"',
        'booking.readerUserId AS "readerUserId"',
      ])
      .limit(1)
      .getRawOne<{ actorUserId: string; readerUserId: string }>();

    return row ?? null;
  }
}
