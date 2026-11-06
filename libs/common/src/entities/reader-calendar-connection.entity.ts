import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ReaderProfile } from './reader-profile.entity';

@Entity({ name: 'reader_calendar_connections', schema: 'marketplace_schema' })
@Index('IDX_calendar_conn_readerProfileId', ['readerProfileId'])
@Index('IDX_calendar_conn_unique', ['readerProfileId', 'provider'], {
  unique: true,
})
export class ReaderCalendarConnection extends BaseEntity {
  @Column({ type: 'uuid' })
  readerProfileId: string;

  @ManyToOne(() => ReaderProfile, (profile) => profile.calendarConnections, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'readerProfileId' })
  readerProfile: ReaderProfile;

  @Column({ type: 'varchar', length: 50 })
  provider: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  externalCalendarId?: string;

  @Column({ type: 'text', nullable: true })
  accessTokenEncrypted?: string;

  @Column({ type: 'text', nullable: true })
  refreshTokenEncrypted?: string;

  /** When the current access token expires. Used to trigger refresh before making API calls. */
  @Column({ type: 'timestamp', nullable: true })
  tokenExpiresAt?: Date;

  /** OAuth scopes granted by the user (space-separated). Determines what the integration can do. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  scope?: string;

  /** Email address of the connected external calendar account. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  connectedEmail?: string;

  /** Whether inbound/outbound sync is active. Reader can pause without disconnecting. */
  @Column({ type: 'boolean', default: true })
  syncEnabled: boolean;

  /** Timestamp of last successful inbound freebusy sync. */
  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt?: Date;

  /** Timestamp of last sync failure (for dashboard display and debugging). */
  @Column({ type: 'timestamp', nullable: true })
  lastErrorAt?: Date;

  /** Last sync error message. Stored for debugging, never exposed publicly. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  lastErrorMessage?: string;

  /** Google push notification channel ID. Null until Sub-Phase C.6 (webhooks). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookChannelId?: string;

  /** Google push notification resource ID. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  webhookResourceId?: string;

  /** When the push notification channel expires and must be renewed. */
  @Column({ type: 'timestamp', nullable: true })
  webhookExpiresAt?: Date;
}
