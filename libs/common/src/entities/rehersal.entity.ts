/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import {
  RehearsalMode,
  RehearsalPartnerType,
  RehearsalRuntimeEngine,
} from '../enums/rehearsal.enum';
import { RehearsalStatus } from '../enums/studio.enum';
import { BaseEntity } from './base.entity';
import { Booking } from './booking.entity';
import { Character } from './character.entity';
import { Project } from './project.entity';
import { Recording } from './recording.entity';
import { Scene } from './scene.entity';
import { Script } from './script.entity';
import { SessionSettings } from '../interfaces/rehearsal-settings.interface';

/**
 * Rehearsal Entity
 *
 * Represents a rehearsal session where a user practices a scene from a script.
 * The rehearsal can have a partner that is either another user or an AI.
 * A rehearsal can have multiple recordings associated with it (e.g., multiple takes or practice sessions).
 *
 * @example
 * // Rehearsal with a user partner
 * {
 *   userId: "user-123",
 *   projectId: "project-456",
 *   scriptId: "script-789",
 *   sceneId: "scene-101",
 *   rehearsalPartnerType: RehearsalPartnerType.USER,
 *   rehearsalPartnerUserId: "partner-user-456",
 *   rehearsalPartnerAiName: null,
 *   rehearsalPartnerAiDescription: null,
 *   rehearsalPartnerAiImage: null,
 *   recordings: [] // Array of recordings associated with this rehearsal
 * }
 *
 * @example
 * // Rehearsal with an AI partner
 * {
 *   userId: "user-123",
 *   projectId: "project-456",
 *   scriptId: "script-789",
 *   sceneId: "scene-101",
 *   rehearsalPartnerType: RehearsalPartnerType.AI,
 *   rehearsalPartnerUserId: null,
 *   rehearsalPartnerAiName: "AI Character Name",
 *   rehearsalPartnerAiDescription: "Description of AI character",
 *   rehearsalPartnerAiImage: "https://example.com/ai-image.jpg",
 *   recordings: [] // Array of recordings associated with this rehearsal
 * }
 */
@Entity({ name: 'rehersals', schema: 'studio_schema' })
@Index(['sceneId'])
@Index(['rehearsalPartnerUserId'])
@Index(['mode'])
@Index(['bookingId'], {
  unique: true,
  where: '"bookingId" IS NOT NULL AND "deletedAt" IS NULL',
})
export class Rehersal extends BaseEntity {
  // user that owns this rehearsal. plain UUID — user data is to be fetched with API composition from auth service, and not database join. example: "8e2ebcd1-7138-48b6-bee8-b61ed03b4160"
  @Column({ nullable: false })
  @Index()
  userId: string;

  // project that this rehearsal belongs to. scene-based rehearsals require this,
  // but booking-backed reader sessions may not yet be attached to a project.
  @Column({ type: 'uuid', nullable: true })
  projectId: string | null;

  // project that this rehearsal belongs to
  @ManyToOne(() => Project, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'projectId' })
  project: Project | null;

  // linked marketplace booking for booked reader sessions
  @Column({ type: 'uuid', nullable: true })
  bookingId: string | null;

  @ManyToOne(() => Booking, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'bookingId' })
  booking: Booking | null;

  // script that this rehearsal is for. scene-based rehearsals require this,
  // but booking-backed reader sessions may leave it null until linked to content.
  @Column({ type: 'uuid', nullable: true })
  scriptId: string | null;

  // script that this rehearsal is for
  @ManyToOne(() => Script, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'scriptId' })
  script: Script | null;

  // scene that this rehearsal is for. scene-based rehearsals require this,
  // but booking-backed reader sessions may be created before scene selection exists.
  @Column({ type: 'uuid', nullable: true })
  sceneId: string | null;

  // scene that this rehearsal is for
  @ManyToOne(() => Scene, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'sceneId' })
  scene: Scene | null;

  // type of rehearsal partner. Null for teleprompter (SOLO mode — no partner).
  @Column({
    type: 'enum',
    enum: RehearsalPartnerType,
    nullable: true,
  })
  rehearsalPartnerType: RehearsalPartnerType | null;

  @Column({
    type: 'enum',
    enum: RehearsalMode,
    default: RehearsalMode.SOLO,
  })
  mode: RehearsalMode;

  @Column({
    type: 'enum',
    enum: RehearsalRuntimeEngine,
    default: RehearsalRuntimeEngine.NONE,
  })
  runtimeEngine: RehearsalRuntimeEngine;

  // ID of the user partner (when rehearsalPartnerType is USER).
  // this is a plain UUID - user data should be fetched via API composition from the auth service, not via database join.
  // this field is required when rehearsalPartnerType is USER, null otherwise
  // example: "8e2ebcd1-7138-48b6-bee8-b61ed03b4160"
  @Column({ nullable: true })
  rehearsalPartnerUserId: string | null;

  // Name of the AI partner (when rehearsalPartnerType is AI)
  // this field is required when rehearsalPartnerType is AI, null otherwise
  // example: "AI Character Name"
  @Column({ nullable: true, type: 'text' })
  rehearsalPartnerAiName: string | null;

  // description of the AI partner (when rehearsalPartnerType is AI)
  // optional field for additional context about the AI character
  // example: "A helpful AI assistant character with a friendly personality"
  @Column({ nullable: true, type: 'text' })
  rehearsalPartnerAiDescription: string | null;

  // image URL for the AI partner (when rehearsalPartnerType is AI)
  // optional field for displaying an avatar or image of the AI character
  // example: "https://example.com/ai-character-avatar.jpg"
  @Column({ nullable: true, type: 'text' })
  rehearsalPartnerAiImage: string | null;

  // status of this rehearsal session
  @Column({
    type: 'enum',
    enum: RehearsalStatus,
    default: RehearsalStatus.CREATED,
  })
  status: RehearsalStatus;

  // ID of the character the actor is playing in this rehearsal.
  // This is intentionally treated as a setup concern and may remain null
  // until the actor explicitly chooses a role.
  @Column({ nullable: true })
  characterId: string | null;

  @ManyToOne(() => Character, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'characterId' })
  character: Character | null;

  // when the rehearsal session actually started
  @Column({ type: 'timestamp', nullable: true })
  startedAt: Date | null;

  // when the rehearsal session ended
  @Column({ type: 'timestamp', nullable: true })
  endedAt: Date | null;

  // total active session duration in seconds
  @Column({ type: 'int', nullable: true })
  sessionDurationSeconds: number | null;

  // recordings associated with this rehearsal. a rehearsal can have multiple recordings (e.g., multiple takes or practice sessions)
  @OneToMany(() => Recording, (recording) => recording.rehearsal)
  recordings: Recording[];

  // cached analytics summary and project progress data
  @Column({ type: 'jsonb', nullable: true })
  metaData: Record<string, any> | null;

  // session settings snapshot (frozen at session start). null = use user defaults / system defaults.
  @Column({ type: 'jsonb', nullable: true })
  sessionSettings: SessionSettings | null;
}
