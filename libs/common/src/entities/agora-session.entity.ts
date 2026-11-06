import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { AgoraSessionStatus } from '../enums/studio.enum';
import { BaseEntity } from './base.entity';
import { Rehersal } from './rehersal.entity';
import { Recording } from './recording.entity';

@Entity({ name: 'agora_sessions', schema: 'studio_schema' })
@Index(['channelName'], { unique: true })
@Index(['bookingId'])
@Index(['rehearsalId'])
export class AgoraSession extends BaseEntity {
  @Column({ type: 'varchar', nullable: false })
  channelName: string;

  // linked booking ID (for reader sessions thru marketplace). plain UUID — booking lives in marketplace_schema.
  @Column({ type: 'uuid', nullable: true })
  bookingId: string | null;

  @Column({ nullable: true })
  rehearsalId: string | null;

  @ManyToOne(() => Rehersal, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'rehearsalId' })
  rehearsal: Rehersal | null;

  @Column({ nullable: true })
  recordingId: string | null;

  @ManyToOne(() => Recording, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'recordingId' })
  recording: Recording | null;

  // user that created this session. plain UUID — user data fetched via API composition from auth service.
  @Column({ nullable: false })
  @Index()
  creatorUserId: string;

  @Column({
    type: 'enum',
    enum: AgoraSessionStatus,
    default: AgoraSessionStatus.CREATED,
  })
  status: AgoraSessionStatus;

  @Column({ nullable: true })
  agoraResourceId: string | null;

  @Column({ nullable: true })
  agoraSid: string | null;

  @Column({ type: 'jsonb', nullable: true })
  cloudRecordingConfig: Record<string, any> | null;

  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  endedAt: Date | null;
}
