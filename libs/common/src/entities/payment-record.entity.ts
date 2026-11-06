import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { PaymentRecordStatus } from '../enums/marketplace.enum';

@Entity({ name: 'payment_records', schema: 'billing_schema' })
@Index('IDX_payment_record_bookingId', ['bookingId'])
@Index('IDX_payment_record_actorUserId', ['actorUserId'])
@Index('IDX_payment_record_readerUserId', ['readerUserId'])
@Index('IDX_payment_record_stripePaymentIntentId', ['stripePaymentIntentId'])
@Index('IDX_payment_record_stripeRefundId', ['stripeRefundId'])
@Index('IDX_payment_record_stripeTransferReversalId', [
  'stripeTransferReversalId',
])
@Index('IDX_payment_record_status', ['status'])
export class PaymentRecord extends BaseEntity {
  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'uuid' })
  readerUserId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripePaymentIntentId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeTransferId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeRefundId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  stripeTransferReversalId?: string;

  @Column({ type: 'integer' })
  amountCents: number;

  @Column({ type: 'integer' })
  platformFeeCents: number;

  @Column({ type: 'integer' })
  readerPayoutCents: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency: string;

  @Column({
    type: 'varchar',
    length: 50,
    default: PaymentRecordStatus.PENDING,
  })
  status: string;

  @Column({ type: 'integer', nullable: true })
  refundAmountCents?: number;

  @Column({ type: 'text', nullable: true })
  refundReason?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  refundStatus?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  reversalStatus?: string;

  @Column({ type: 'text', nullable: true })
  refundFailureReason?: string;

  @Column({ type: 'text', nullable: true })
  reversalFailureReason?: string;

  @Column({ type: 'jsonb', nullable: true })
  refundMetaData?: Record<string, any>;

  @Column({ type: 'timestamp', nullable: true })
  refundRequestedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  refundedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  reversalRequestedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  reversalCompletedAt?: Date;

  // ── Settlement fields (separate charges and transfers) ──────────────
  // Tracks the lifecycle of platform-initiated transfers to the reader's
  // connected account. Only used when paymentModel = 'separate'.

  @Column({
    type: 'varchar',
    length: 30,
    nullable: true,
    default: 'destination',
  })
  paymentModel?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  settlementStatus?: string;

  @Column({ type: 'timestamp', nullable: true })
  settlementEligibleAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  settledAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  settlementMetaData?: Record<string, any>;
}
