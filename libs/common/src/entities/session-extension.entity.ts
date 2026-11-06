import { Column, Entity, Index } from 'typeorm';
import { SessionExtensionStatus } from '../enums/marketplace.enum';
import { BaseEntity } from './base.entity';

@Entity({ name: 'session_extensions', schema: 'marketplace_schema' })
@Index('IDX_session_extension_bookingId', ['bookingId'])
@Index('IDX_session_extension_status', ['status'])
@Index('IDX_session_extension_stripePaymentIntentId', ['stripePaymentIntentId'])
export class SessionExtension extends BaseEntity {
  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'uuid' })
  requestedByUserId: string;

  @Column({ type: 'uuid', nullable: true })
  approvedByUserId?: string;

  @Column({ type: 'integer' })
  extensionDurationMinutes: number;

  @Column({ type: 'integer' })
  extensionPriceCents: number;

  @Column({ type: 'integer' })
  platformFeeCents: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: SessionExtensionStatus.REQUESTED,
  })
  status: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripePaymentIntentId?: string;

  @Column({ type: 'timestamp' })
  previousSessionEndUtc: Date;

  @Column({ type: 'timestamp' })
  newSessionEndUtc: Date;

  @Column({ type: 'integer' })
  extensionNumber: number;

  @Column({ type: 'timestamp' })
  requestedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  approvedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  paymentConfirmedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  activatedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiredAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  declinedAt?: Date;

  @Column({ type: 'text', nullable: true })
  declineReason?: string;

  @Column({ type: 'jsonb', nullable: true })
  metaData?: Record<string, any>;
}
