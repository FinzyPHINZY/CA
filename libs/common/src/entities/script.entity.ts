import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { ScriptStatus } from '../enums/enums';
import { BaseEntity } from './base.entity';
import { Character } from './character.entity';
import { Project } from './project.entity';

@Entity({ name: 'scripts', schema: 'core_schema' })
@Index('IDX_script_projectId', ['projectId'])
@Index('IDX_script_taskId', ['taskId'])
@Index('IDX_script_sourceMediaId', ['sourceMediaId'])
@Index('UQ_script_project_sourceMediaId', ['projectId', 'sourceMediaId'], {
  unique: true,
  where:
    '"projectId" IS NOT NULL AND "sourceMediaId" IS NOT NULL AND "deletedAt" IS NULL',
})
export class Script extends BaseEntity {
  @Column()
  @Index()
  title: string;

  @Column()
  @Index()
  userId: string;

  @Column({ nullable: true })
  projectId: string | null;

  @ManyToOne(() => Project, (project) => project.scripts, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'projectId' })
  project: Project | null;

  @Column({ unique: true, nullable: true })
  taskId: string | null;

  @Column({ nullable: true })
  sourceMediaId: string | null;

  /**
   * Optional default role (character) for this script.
   * Useful as a primary character or default casting reference.
   */
  @Column({ name: 'defaultCharacterId', nullable: true })
  defaultCharacterId: string | null;

  @ManyToOne(() => Character, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'defaultCharacterId' })
  defaultCharacter: Character | null;

  @Column({ type: 'enum', enum: ScriptStatus })
  status: ScriptStatus;

  @Column()
  fileUrl: string;

  @Column({ nullable: true })
  analysisId: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'parser_metadata' })
  parserMetadata: Record<string, any> | null;

  @Column({ type: 'integer', nullable: true, default: 0 })
  progress: number | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ nullable: true })
  @Index('IDX_script_contentHash')
  contentHash: string | null;
}
