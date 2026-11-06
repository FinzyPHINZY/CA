import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import {
  ReaderWorkSampleSourceType,
  WorkSampleType,
} from '../enums/marketplace.enum';
import { BaseEntity } from './base.entity';
import { ReaderProfile } from './reader-profile.entity';

@Entity({ name: 'reader_work_samples', schema: 'marketplace_schema' })
@Index('IDX_work_sample_readerProfileId', ['readerProfileId'])
@Index('IDX_work_sample_mediaId', ['mediaId'])
export class ReaderWorkSample extends BaseEntity {
  @Column({ type: 'uuid' })
  readerProfileId: string;

  @ManyToOne(() => ReaderProfile, (profile) => profile.workSamples, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'readerProfileId' })
  readerProfile: ReaderProfile;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'varchar', length: 500 })
  url: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  thumbnailUrl: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    default: ReaderWorkSampleSourceType.EXTERNAL_LINK,
  })
  sourceType: string;

  @Column({ type: 'uuid', nullable: true })
  mediaId: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    default: WorkSampleType.VIDEO,
  })
  type: string;
}
