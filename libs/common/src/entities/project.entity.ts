/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  UpdateDateColumn,
} from 'typeorm';
import { ProjectStatus } from '../enums/enums';
import { BaseEntity } from './base.entity';
import { ProjectFlagged } from './project-flagged.entity';
import { Script } from './script.entity';

@Entity({ name: 'projects', schema: 'core_schema' })
@Index('IDX_project_userId_title', ['userId', 'title'])
@Index('IDX_project_userId', ['userId'])
@Index('IDX_project_status', ['status'])
export class Project extends BaseEntity {
  @Column()
  userId: string;

  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({
    type: 'enum',
    enum: ProjectStatus,
    default: ProjectStatus.DRAFT,
  })
  @Index()
  status: ProjectStatus;

  @Column({ type: 'boolean', default: false })
  @Index()
  isFlagged: boolean;

  @OneToMany(() => Script, (script) => script.project, { cascade: true })
  scripts: Script[];

  @OneToMany(() => ProjectFlagged, (flag) => flag.project)
  flags: ProjectFlagged[];

  // cached project-level analytics (progress, scene comparison)
  @Column({ type: 'jsonb', nullable: true })
  metaData: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @UpdateDateColumn({
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt: Date;
}
