import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ReaderProfile } from './reader-profile.entity';

@Entity({ name: 'reader_reviews', schema: 'marketplace_schema' })
@Index('IDX_review_readerProfileId', ['readerProfileId'])
@Index('IDX_review_reviewerUserId', ['reviewerUserId'])
@Index('IDX_review_bookingId', ['bookingId'], { unique: true })
export class ReaderReview extends BaseEntity {
  @Column({ type: 'uuid' })
  readerProfileId: string;

  @ManyToOne(() => ReaderProfile, (profile) => profile.reviews, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'readerProfileId' })
  readerProfile: ReaderProfile;

  @Column({ name: 'reviewerId', type: 'uuid' })
  reviewerUserId: string;

  @Column({ type: 'uuid' })
  bookingId: string;

  @Column({ type: 'smallint' })
  rating: number;

  @Column({ type: 'text', nullable: true })
  comment?: string;
}
