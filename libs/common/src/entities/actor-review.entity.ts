import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'actor_reviews', schema: 'marketplace_schema' })
@Index('IDX_actor_review_actorUserId', ['actorUserId'])
@Index('IDX_actor_review_reviewerUserId', ['reviewerUserId'])
@Index('IDX_actor_review_bookingId', ['bookingId'], { unique: true })
export class ActorReview extends BaseEntity {
  @Column({ type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'uuid' })
  reviewerUserId: string;

  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'smallint' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment?: string;
}
