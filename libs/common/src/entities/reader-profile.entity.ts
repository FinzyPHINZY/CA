import { Column, Entity, Index, OneToMany } from 'typeorm';
import {
  CancellationPolicy,
  OnboardingStatus,
  OnboardingStep,
} from '../enums/marketplace.enum';
import { BaseEntity } from './base.entity';
import { ReaderCalendarConnection } from './reader-calendar-connection.entity';
import { ReaderReview } from './reader-review.entity';
import { ReaderSessionRate } from './reader-session-rate.entity';
import { ReaderSocialLink } from './reader-social-link.entity';
import { ReaderSpecialty } from './reader-specialty.entity';
import { ReaderWorkSample } from './reader-work-sample.entity';

@Entity({ name: 'reader_profiles', schema: 'marketplace_schema' })
@Index('IDX_reader_profile_userId', ['userId'], { unique: true })
@Index('IDX_reader_profile_avgRating', ['avgRating'])
@Index('IDX_reader_profile_totalSessions', ['totalSessions'])
@Index('IDX_reader_profile_isAcceptingBookings', ['isAcceptingBookings'])
export class ReaderProfile extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'text', nullable: true })
  bio?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  headline?: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: OnboardingStatus.NOT_STARTED,
  })
  onboardingStatus: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: OnboardingStep.BIO,
  })
  onboardingStep: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeAccountId?: string;

  @Column({ type: 'boolean', default: false })
  stripeOnboardingComplete: boolean;

  @Column({ type: 'boolean', default: false })
  isAcceptingBookings: boolean;

  @Column({ type: 'boolean', default: false })
  isOnline: boolean;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  avgRating: number;

  @Column({ type: 'integer', default: 0 })
  totalSessions: number;

  @Column({ type: 'integer', default: 0 })
  totalReviews: number;

  @Column({ type: 'integer', nullable: true })
  responseTimeMinutes?: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  websiteUrl?: string;

  @Column({ type: 'integer', nullable: true })
  yearsOfExperience?: number;

  @Column({ type: 'integer', default: 10 })
  bufferMinutes: number;

  @Column({
    type: 'varchar',
    length: 50,
    default: CancellationPolicy.FLEXIBLE,
  })
  cancellationPolicy: string;

  /** Whether this reader allows session extensions. */
  @Column({ type: 'boolean', default: true })
  allowSessionExtensions: boolean;

  @OneToMany(() => ReaderSessionRate, (rate) => rate.readerProfile, {
    cascade: true,
  })
  sessionRates: ReaderSessionRate[];

  @OneToMany(() => ReaderSpecialty, (specialty) => specialty.readerProfile, {
    cascade: true,
  })
  specialties: ReaderSpecialty[];

  @OneToMany(() => ReaderWorkSample, (sample) => sample.readerProfile, {
    cascade: true,
  })
  workSamples: ReaderWorkSample[];

  @OneToMany(() => ReaderSocialLink, (link) => link.readerProfile, {
    cascade: true,
  })
  socialLinks: ReaderSocialLink[];

  @OneToMany(() => ReaderCalendarConnection, (conn) => conn.readerProfile, {
    cascade: true,
  })
  calendarConnections: ReaderCalendarConnection[];

  @OneToMany(() => ReaderReview, (review) => review.readerProfile)
  reviews: ReaderReview[];
}
