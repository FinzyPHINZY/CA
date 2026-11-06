import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'rehearsal_reviews', schema: 'studio_schema' })
@Index(
  'IDX_rehearsal_review_rehearsalId_reviewerUserId',
  ['rehearsalId', 'reviewerUserId'],
  { unique: true },
)
@Index('IDX_rehearsal_review_revieweeUserId', ['revieweeUserId'])
export class RehearsalReview extends BaseEntity {
  @Column({ type: 'uuid' })
  rehearsalId: string;

  /** The participant who wrote this review. */
  @Column({ type: 'uuid' })
  reviewerUserId: string;

  /** The participant being reviewed. */
  @Column({ type: 'uuid' })
  revieweeUserId: string;

  @Column({ type: 'smallint' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment?: string;
}
