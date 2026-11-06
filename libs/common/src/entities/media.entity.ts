import { Column, Entity, Index } from 'typeorm';
import { MediaType } from '../enums/enums';
import { BaseEntity } from './base.entity';

@Entity({ name: 'media', schema: 'media_schema' })
@Index('IDX_media_userId', ['userId'])
@Index('IDX_media_type', ['type'])
export class Media extends BaseEntity {
  @Column({ type: 'enum', enum: MediaType })
  type: MediaType;

  @Column()
  url: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column()
  userId: string;

  @Column({ nullable: true })
  fileName: string | null;

  @Column({ nullable: true })
  contentType: string | null;

  @Column({ nullable: true })
  s3Key: string | null; // S3 object key for reference

  // sha256 of the uploaded bytes. Populated on script + generic uploads so
  // downstream consumers can cache analysis results across sessions without
  // re-downloading the object.
  @Column({ type: 'varchar', length: 64, nullable: true })
  contentHash: string | null;

  @Column({ name: 'durationMs', type: 'integer', nullable: true })
  durationMs: number | null;
}
