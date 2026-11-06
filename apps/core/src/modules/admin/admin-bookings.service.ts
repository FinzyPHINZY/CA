import { Booking, PaymentRecord, User } from '@app/common';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { buildBookingFinancialState } from '../marketplace/booking/booking-financial-state.util';
import { ListAdminBookingsQueryDto } from './dto/list-admin-bookings-query.dto';
import {
  ADMIN_BOOKING_ACTOR_ALIAS,
  ADMIN_BOOKING_READER_ALIAS,
} from './admin-query-aliases';

export interface AdminBookingListItem {
  id: string;
  status: string;
  bookingType: string;
  actorUserId: string;
  readerUserId: string;
  sessionStartUtc: Date;
  sessionEndUtc: Date;
  priceCents: number;
  currency: string;
  noShowResolvedAt: Date | null;
  actor: { id: string; fullName: string | null; email: string | null };
  reader: { id: string; fullName: string | null; email: string | null };
  financialState: ReturnType<typeof buildBookingFinancialState>;
}

@Injectable()
export class AdminBookingsService {
  constructor(private readonly dataSource: DataSource) {}

  async listBookings(query: ListAdminBookingsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;

    const b = 'b';
    const actor = ADMIN_BOOKING_ACTOR_ALIAS;
    const reader = ADMIN_BOOKING_READER_ALIAS;

    const qb = this.dataSource
      .getRepository(Booking)
      .createQueryBuilder(b)
      .leftJoin(User, actor, `${actor}.id = ${b}."actorUserId"`)
      .leftJoin(User, reader, `${reader}.id = ${b}."readerUserId"`)
      .where(`${b}."deletedAt" IS NULL`);

    if (query.status) {
      qb.andWhere(`${b}.status = :status`, { status: query.status });
    }

    const total = await qb.clone().getCount();
    const rows = await qb
      .select([
        `${b}.id AS "id"`,
        `${b}.status AS "status"`,
        `${b}."bookingType" AS "bookingType"`,
        `${b}."actorUserId" AS "actorUserId"`,
        `${b}."readerUserId" AS "readerUserId"`,
        `${b}."sessionStartUtc" AS "sessionStartUtc"`,
        `${b}."sessionEndUtc" AS "sessionEndUtc"`,
        `${b}."priceCents" AS "priceCents"`,
        `${b}.currency AS "currency"`,
        `${b}."noShowResolvedAt" AS "noShowResolvedAt"`,
        `${actor}.id AS "actorId"`,
        `${actor}.fullName AS "actorFullName"`,
        `${actor}.email AS "actorEmail"`,
        `${reader}.id AS "readerId"`,
        `${reader}.fullName AS "readerFullName"`,
        `${reader}.email AS "readerEmail"`,
      ])
      .orderBy(`${b}."createdAt"`, 'DESC')
      .offset(offset)
      .limit(limit)
      .getRawMany<{
        id: string;
        status: string;
        bookingType: string;
        actorUserId: string;
        readerUserId: string;
        sessionStartUtc: Date;
        sessionEndUtc: Date;
        priceCents: number;
        currency: string;
        noShowResolvedAt: Date | null;
        actorId: string;
        actorFullName: string | null;
        actorEmail: string | null;
        readerId: string;
        readerFullName: string | null;
        readerEmail: string | null;
      }>();

    const items = await this.attachFinancialState(rows);
    const totalPages = Math.ceil(total / limit) || 1;

    return {
      success: true,
      message: 'Bookings retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async getBookingById(bookingId: string) {
    const booking = await this.dataSource.getRepository(Booking).findOne({
      where: { id: bookingId },
    });
    if (!booking || booking.deletedAt) {
      throw new NotFoundException('Booking not found');
    }

    const [actor, reader, payment] = await Promise.all([
      this.dataSource.getRepository(User).findOne({
        where: { id: booking.actorUserId },
      }),
      this.dataSource.getRepository(User).findOne({
        where: { id: booking.readerUserId },
      }),
      this.dataSource.getRepository(PaymentRecord).findOne({
        where: { bookingId },
      }),
    ]);

    return {
      success: true,
      message: 'Booking retrieved successfully',
      data: {
        booking,
        actor: actor
          ? {
              id: actor.id,
              fullName: actor.fullName ?? null,
              email: actor.email ?? null,
            }
          : { id: booking.actorUserId, fullName: null, email: null },
        reader: reader
          ? {
              id: reader.id,
              fullName: reader.fullName ?? null,
              email: reader.email ?? null,
            }
          : { id: booking.readerUserId, fullName: null, email: null },
        financialState: buildBookingFinancialState(payment, booking),
        payments: payment ? [payment] : [],
      },
    };
  }

  private async attachFinancialState(
    rows: Array<{
      id: string;
      status: string;
      bookingType: string;
      actorUserId: string;
      readerUserId: string;
      sessionStartUtc: Date;
      sessionEndUtc: Date;
      priceCents: number;
      currency: string;
      noShowResolvedAt: Date | null;
      actorId: string;
      actorFullName: string | null;
      actorEmail: string | null;
      readerId: string;
      readerFullName: string | null;
      readerEmail: string | null;
    }>,
  ): Promise<AdminBookingListItem[]> {
    if (rows.length === 0) {
      return [];
    }

    const payments = await this.dataSource.getRepository(PaymentRecord).find({
      where: { bookingId: In(rows.map((row) => row.id)) },
    });
    const paymentByBookingId = new Map(
      payments.map((payment) => [payment.bookingId, payment]),
    );

    return rows.map((row) => {
      const payment = paymentByBookingId.get(row.id);
      const bookingStub = {
        id: row.id,
        status: row.status,
        metaData: undefined,
      } as Booking;

      return {
        id: row.id,
        status: row.status,
        bookingType: row.bookingType,
        actorUserId: row.actorUserId,
        readerUserId: row.readerUserId,
        sessionStartUtc: new Date(row.sessionStartUtc),
        sessionEndUtc: new Date(row.sessionEndUtc),
        priceCents: row.priceCents,
        currency: row.currency,
        noShowResolvedAt: row.noShowResolvedAt
          ? new Date(row.noShowResolvedAt)
          : null,
        actor: {
          id: row.actorId,
          fullName: row.actorFullName ?? null,
          email: row.actorEmail ?? null,
        },
        reader: {
          id: row.readerId,
          fullName: row.readerFullName ?? null,
          email: row.readerEmail ?? null,
        },
        financialState: buildBookingFinancialState(payment, bookingStub),
      };
    });
  }
}
