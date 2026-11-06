import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Project } from './project.entity';
import { User } from './user.entity';

export enum ProjectFlagStatus {
  PENDING = 'PENDING',
  REVIEWED = 'REVIEWED',
}

@Entity({ name: 'project_flagged', schema: 'core_schema' })
@Index(['projectId'])
@Index(['flaggedByUserId'])
@Index(['isActive'])
export class ProjectFlagged extends BaseEntity {
  @Column({ type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, (project) => project.flags, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Column({ type: 'uuid', nullable: true })
  flaggedByUserId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'flaggedByUserId' })
  flaggedByUser: User | null;

  @Column({ type: 'text', nullable: true })
  flaggedByName: string | null;

  @Column({ type: 'text', nullable: true })
  flaggedByEmail: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({
    type: 'enum',
    enum: ProjectFlagStatus,
    default: ProjectFlagStatus.PENDING,
  })
  status: ProjectFlagStatus;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
