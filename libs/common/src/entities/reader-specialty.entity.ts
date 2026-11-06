import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ReaderProfile } from './reader-profile.entity';

@Entity({ name: 'reader_specialties', schema: 'marketplace_schema' })
@Index('IDX_specialty_readerProfileId', ['readerProfileId'])
@Index('IDX_specialty_genre', ['genre'])
@Index('IDX_specialty_unique', ['readerProfileId', 'genre'], { unique: true })
export class ReaderSpecialty extends BaseEntity {
  @Column({ type: 'uuid' })
  readerProfileId: string;

  @ManyToOne(() => ReaderProfile, (profile) => profile.specialties, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'readerProfileId' })
  readerProfile: ReaderProfile;

  @Column({ type: 'varchar', length: 100 })
  genre: string;
}
