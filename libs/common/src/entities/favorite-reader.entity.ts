import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'favorite_readers', schema: 'marketplace_schema' })
@Index('IDX_favorite_userId', ['userId'])
@Index('IDX_favorite_readerProfileId', ['readerProfileId'])
@Index('IDX_favorite_unique', ['userId', 'readerProfileId'], { unique: true })
export class FavoriteReader extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  readerProfileId: string;
}
