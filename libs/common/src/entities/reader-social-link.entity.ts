import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ReaderProfile } from './reader-profile.entity';

@Entity({ name: 'reader_social_links', schema: 'marketplace_schema' })
@Index('IDX_social_link_readerProfileId', ['readerProfileId'])
@Index('IDX_social_link_unique', ['readerProfileId', 'platform'], {
  unique: true,
})
export class ReaderSocialLink extends BaseEntity {
  @Column({ type: 'uuid' })
  readerProfileId: string;

  @ManyToOne(() => ReaderProfile, (profile) => profile.socialLinks, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'readerProfileId' })
  readerProfile: ReaderProfile;

  @Column({ type: 'varchar', length: 50 })
  platform: string;

  @Column({ type: 'varchar', length: 500 })
  url: string;
}
