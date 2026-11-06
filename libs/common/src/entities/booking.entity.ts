import { Column, Entity, Index } from 'typeorm';
import { BookingStatus, BookingType } from '../enums/marketplace.enum';
import { BaseEntity } from './base.entity';

@Entity({ name: 'bookings', schema: 'marketplace_schema' })
@Index('IDX_booking_actorUserId', ['actorUserId'])
@Index('IDX_booking_readerUserId', ['readerUserId'])
@Index('IDX_booking_readerProfileId', ['readerProfileId'])
@Index('IDX_booking_timeSlotId', ['timeSlotId'])
@Index('IDX_booking_status', ['status'])
@Index('IDX_booking_bookingType', ['bookingType'])
@Index('IDX_booking_stripePaymentIntentId', ['stripePaymentIntentId'])
export class Booking extends BaseEntity {
  @Column({ type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'uuid' })
  readerUserId: string;

  @Column({ type: 'uuid' })
  readerProfileId: string;

  @Column({ type: 'uuid', nullable: true })
  timeSlotId?: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: BookingStatus.HELD,
  })
  status: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: BookingType.SCHEDULED,
  })
  bookingType: string;

  @Column({ type: 'integer' })
  sessionDurationMinutes: number;

  @Column({ type: 'integer' })
  priceCents: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency: string;

  @Column({ type: 'integer' })
  platformFeeCents: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripePaymentIntentId?: string;

  @Column({ type: 'text', nullable: true })
  cancellationReason?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  cancelledBy?: string;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt?: Date;

  @Column({ type: 'varchar', length: 50, nullable: true })
  noShowBy?: string;

  @Column({ type: 'uuid', nullable: true })
  noShowResolvedByUserId?: string;

  @Column({ type: 'timestamp', nullable: true })
  noShowResolvedAt?: Date;

  @Column({ type: 'timestamp' })
  sessionStartUtc: Date;

  @Column({ type: 'timestamp' })
  sessionEndUtc: Date;

  /** Whether the actor allows session extensions for this booking. */
  @Column({ type: 'boolean', default: true })
  extensionAllowed: boolean;

  /** Number of activated extensions for this booking. */
  @Column({ type: 'integer', default: 0 })
  extensionCount: number;

  /** Snapshot of the original session duration before any extensions. */
  @Column({ type: 'integer', nullable: true })
  originalSessionDurationMinutes?: number;

  /** Stores external calendar event IDs (googleEventId, outlookEventId) and any future booking-level metadata. */
  @Column({ type: 'jsonb', nullable: true })
  metaData?: Record<string, any>;
}
