import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Scene } from './scene.entity';
import { Script } from './script.entity';

@Entity({ name: 'characters', schema: 'core_schema' })
@Index(['scriptId', 'name'], { unique: true })
export class Character extends BaseEntity {
  @Column()
  scriptId: string;

  @ManyToOne(() => Script, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scriptId' })
  script: Script;

  @Column()
  @Index()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'text', nullable: true })
  background: string | null;

  @Column({ type: 'text', nullable: true })
  definingPersonalityTraits: string | null;

  @Column({ type: 'text', nullable: true })
  perception: string | null;

  @Column({ type: 'text', nullable: true })
  goalAndConflict: string | null;

  @Column({ type: 'text', nullable: true })
  emotionalArc: string | null;

  @Column({ type: 'text', nullable: true })
  relationships: string | null;

  @Column({ type: 'text', nullable: true })
  subtextAndCoreTruth: string | null;

  @Column({ type: 'jsonb', nullable: true })
  voiceProfile: {
    gender?: 'male' | 'female' | 'neutral';
    ageCategory?: 'young' | 'middle' | 'old';
    accent?: string;
  } | null;

  @ManyToMany(() => Scene, (scene) => scene.characters)
  scenes: Scene[];
}
