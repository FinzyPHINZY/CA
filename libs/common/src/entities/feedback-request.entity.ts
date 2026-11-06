import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'feedback_requests', schema: 'marketplace_schema' })
@Index('IDX_feedback_request_actorUserId', ['actorUserId'])
@Index('IDX_feedback_request_readerUserId', ['readerUserId'])
@Index('IDX_feedback_request_bookingId', ['bookingId'], { unique: true })
export class FeedbackRequest extends BaseEntity {
  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'uuid' })
  readerUserId: string;

  /** When the actor was asked to review the reader. */
  @Column({ type: 'timestamp', nullable: true })
  actorFeedbackRequestedAt: Date | null;

  /** When the actor actually submitted their review. */
  @Column({ type: 'timestamp', nullable: true })
  actorFeedbackSubmittedAt: Date | null;

  /** When the reader was asked to review the actor. */
  @Column({ type: 'timestamp', nullable: true })
  readerFeedbackRequestedAt: Date | null;

  /** When the reader actually submitted their review. */
  @Column({ type: 'timestamp', nullable: true })
  readerFeedbackSubmittedAt: Date | null;
}
