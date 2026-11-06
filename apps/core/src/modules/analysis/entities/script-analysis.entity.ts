/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { BaseEntity, Script } from '@app/common';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  UpdateDateColumn,
} from 'typeorm';
// note: i removed user import. userId is now a plain UUID for cross-schema decoupling

export enum AnalysisStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity({ name: 'script_analyses', schema: 'ai_schema' })
@Index(['taskId'], { unique: true })
@Index(['scriptId'])
@Index(['userId'])
@Index(['status'])
export class ScriptAnalysis extends BaseEntity {
  @Column({ unique: true })
  taskId: string;

  // user id who owns this analysis.
  // note: this is a plain uuid - user data should be fetched via API composition from the auth service, not via database join.
  @Column()
  userId: string;

  @Column()
  scriptId: string;

  @ManyToOne(() => Script, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scriptId' })
  script: Script;

  @Column({
    type: 'enum',
    enum: AnalysisStatus,
    default: AnalysisStatus.PENDING,
  })
  status: AnalysisStatus;

  @Column({ nullable: true, type: 'text' })
  summary: string | null;

  @Column({ type: 'jsonb', nullable: true })
  characters: any;

  @Column({ type: 'jsonb', nullable: true })
  scenes: any;

  @Column({ type: 'jsonb', nullable: true })
  themes: any;

  @Column({ type: 'jsonb', nullable: true })
  genres: string[] | null;

  @Column({ type: 'text', nullable: true })
  targetAudience: string | null;

  @Column({ type: 'text', nullable: true })
  tone: string | null;

  @Column({ type: 'text', nullable: true })
  style: string | null;

  @Column({ type: 'text', nullable: true })
  structure: string | null;

  @Column({ type: 'text', nullable: true })
  pacing: string | null;

  @Column({ type: 'text', nullable: true })
  dialogue: string | null;

  @Column({ type: 'text', nullable: true })
  action: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  environmentalInfluence: string | null;

  @Column({ type: 'text', nullable: true })
  conclusion: string | null;

  @Column({ type: 'text', nullable: true })
  relationship: string | null;

  @Column({ type: 'text', nullable: true })
  subText: string | null;

  @Column({ type: 'text', nullable: true })
  coreThought: string | null;

  @Column({ type: 'float', nullable: true })
  aiConfidenceScore: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;
}
