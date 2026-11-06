import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'user_teleprompter_preferences', schema: 'studio_schema' })
@Index(['userId'], { unique: true })
export class UserTeleprompterPreference extends BaseEntity {
  @Column({ nullable: false })
  userId: string;

  @Column({ type: 'float', default: 150 })
  defaultScrollSpeed: number;

  @Column({ type: 'int', default: 32 })
  fontSize: number;

  @Column({ type: 'boolean', default: false })
  blackoutMode: boolean;

  @Column({ type: 'boolean', default: true })
  showActionLines: boolean;

  @Column({ type: 'boolean', default: true })
  showParentheticals: boolean;

  @Column({ type: 'varchar', default: '#FFD700' })
  highlightColor: string;
}
