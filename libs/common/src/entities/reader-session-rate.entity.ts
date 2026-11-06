import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ReaderProfile } from './reader-profile.entity';

@Entity({ name: 'reader_session_rates', schema: 'marketplace_schema' })
@Index('IDX_session_rate_readerProfileId', ['readerProfileId'])
@Index('IDX_session_rate_priceCents', ['priceCents'])
export class ReaderSessionRate extends BaseEntity {
  @Column({ type: 'uuid' })
  readerProfileId: string;

  @ManyToOne(() => ReaderProfile, (profile) => profile.sessionRates, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'readerProfileId' })
  readerProfile: ReaderProfile;

  @Column({ type: 'integer' })
  durationMinutes: number;

  @Column({ type: 'integer' })
  priceCents: number;

  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency: string;
}
