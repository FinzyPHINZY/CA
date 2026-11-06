import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { MaterialType } from '../enums/enums';
import { BaseEntity } from './base.entity';
import { Project } from './project.entity';
import { Script } from './script.entity';

@Entity({ name: 'script_materials', schema: 'core_schema' })
@Index('IDX_script_material_scriptId', ['scriptId'])
@Index('IDX_script_material_projectId', ['projectId'])
@Index('IDX_script_material_userId', ['userId'])
@Index('IDX_script_material_projectId_type', ['projectId', 'type'])
@Index('IDX_script_material_scriptId_type', ['scriptId', 'type'])
export class ScriptMaterial extends BaseEntity {
  @Column({ type: 'uuid' })
  scriptId: string;

  @ManyToOne(() => Script, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scriptId' })
  script: Script;

  @Column({ type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Project;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 50 })
  type: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  // LINK type
  @Column({ type: 'varchar', length: 2048, nullable: true })
  url: string | null;

  // TEXT type
  @Column({ type: 'text', nullable: true })
  textContent: string | null;

  // FILE type
  @Column({ type: 'varchar', length: 500, nullable: true })
  fileKey: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  fileUrl: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fileName: string | null;

  @Column({ type: 'integer', nullable: true })
  fileSizeBytes: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  mimeType: string | null;
}
