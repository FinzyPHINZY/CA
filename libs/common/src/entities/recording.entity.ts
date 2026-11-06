/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { RecordingMode, RecordingStatus, RecordingTypeEnum } from '../enums';
import { BaseEntity } from './base.entity';
import { Media } from './media.entity';
import { Project } from './project.entity';
import { Rehersal } from './rehersal.entity';
import { Scene } from './scene.entity';
import { Script } from './script.entity';
// note: i removed user import. userId is now a plain UUID for cross-schema decoupling

@Entity({ name: 'recordings', schema: 'studio_schema' })
@Index(['projectId', 'scriptId', 'sceneId'])
@Index(['rehearsalId'])
export class Recording extends BaseEntity {
  @Column({ type: 'text', nullable: true })
  titleCard: string | null;

  @Column({
    type: 'enum',
    enum: RecordingTypeEnum,
    default: RecordingTypeEnum.AI_PARTNER,
  })
  type: RecordingTypeEnum;

  @Column({
    type: 'enum',
    enum: RecordingMode,
    nullable: true,
  })
  mode: RecordingMode | null;

  @Column({
    type: 'enum',
    enum: RecordingStatus,
    default: RecordingStatus.PENDING,
  })
  status: RecordingStatus;

  @Column({ nullable: true })
  agoraChannelId: string | null;

  @Column({ nullable: true })
  agoraResourceId: string | null;

  @Column({ nullable: true })
  cloudRecordingSid: string | null;

  @Column({ nullable: false })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Column({ nullable: false })
  scriptId: string;

  @ManyToOne(() => Script, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scriptId' })
  script: Script;

  @Column({ nullable: false })
  sceneId: string;

  @ManyToOne(() => Scene, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sceneId' })
  scene: Scene;

  // user that owns this recording. plain UUID — user data is to be fetched with API composition from auth service, and not database join.
  @Column({ nullable: false })
  @Index()
  userId: string;

  @Column({ nullable: true })
  rehearsalId: string | null;

  @ManyToOne(() => Rehersal, (rehearsal) => rehearsal.recordings, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'rehearsalId' })
  rehearsal: Rehersal | null;

  @ManyToMany(() => Media, { onDelete: 'CASCADE' })
  @JoinTable({
    name: 'recording_takes',
    schema: 'studio_schema',
    joinColumn: { name: 'recordingId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mediaId', referencedColumnName: 'id' },
  })
  takes: Media[];

  @ManyToMany(() => Media, { onDelete: 'CASCADE' })
  @JoinTable({
    name: 'recording_media_resources',
    schema: 'studio_schema',
    joinColumn: { name: 'recordingId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mediaId', referencedColumnName: 'id' },
  })
  mediaResources: Media[];

  @Column({ nullable: true })
  summary: string | null;

  @Column({ name: 'durationMs', type: 'integer', nullable: true })
  durationMs: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metaData: Record<string, any> | null;
}
