import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { DayOfWeek } from '../enums/day-of-week.enum';
import { TimeSlotStatus } from '../enums/marketplace.enum';
import { Availability } from './availability.entity';
import { BaseEntity } from './base.entity';

@Entity({ name: 'time_slots', schema: 'marketplace_schema' })
@Index(
  'IDX_timeSlot_composite_unique',
  ['availabilityId', 'dayOfWeek', 'startTime', 'endTime', 'date'],
  {
    unique: true,
  },
)
@Index('IDX_timeSlot_availabilityId', ['availabilityId'])
@Index('IDX_timeSlot_date', ['date'])
@Index('IDX_timeSlot_status', ['status'])
@Index('IDX_timeSlot_startTimeUtc', ['startTimeUtc'])
export class TimeSlot extends BaseEntity {
  @Column({ type: 'uuid' })
  availabilityId: string;

  @ManyToOne(() => Availability, (availability) => availability.timeSlots, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'availabilityId' })
  availability: Availability;

  @Column({
    type: 'enum',
    enum: DayOfWeek,
  })
  @Index('IDX_timeSlot_dayOfWeek')
  dayOfWeek: DayOfWeek;

  /** Template time in HH:mm format (reader's local time at time of creation). */
  @Column({ type: 'time' })
  startTime: string;

  @Column({ type: 'time' })
  endTime: string;

  /** Concrete date for generated slots (YYYY-MM-DD). Null for template slots. */
  @Column({ type: 'date', nullable: true })
  date?: string;

  /** Concrete UTC start timestamp for bookable slots. */
  @Column({ type: 'timestamp', nullable: true })
  startTimeUtc?: Date;

  /** Concrete UTC end timestamp for bookable slots. */
  @Column({ type: 'timestamp', nullable: true })
  endTimeUtc?: Date;

  /** Slot booking status. Null for template slots. */
  @Column({
    type: 'varchar',
    length: 50,
    default: TimeSlotStatus.AVAILABLE,
  })
  status: string;

  /** Booking ID if slot is held/confirmed. */
  @Column({ type: 'uuid', nullable: true })
  bookingId?: string;

  /** Booking ID that caused this slot to be BLOCKED (overlapping session or buffer window). Cleared when that booking is cancelled. */
  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_timeSlot_blockedByBookingId')
  blockedByBookingId?: string | null;
}
