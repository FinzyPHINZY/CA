import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { TimeSlot } from './time-slot.entity';
// note: i removed user import. userId is now a plain UUID for cross-schema decoupling

@Entity({ name: 'availabilities', schema: 'marketplace_schema' })
@Index('IDX_availability_userId_unique', ['userId'], { unique: true })
export class Availability extends BaseEntity {
  // user id who owns this availability.
  // note: this is a plain uuid - user data should be fetched via API composition from the auth service, not via database join.
  @Column({ type: 'uuid' })
  userId: string;

  @OneToMany(() => TimeSlot, (timeSlot) => timeSlot.availability, {
    cascade: true,
    eager: false,
  })
  timeSlots: TimeSlot[];
}
