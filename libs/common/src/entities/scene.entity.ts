import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Character } from './character.entity';
import { Script } from './script.entity';

@Entity({ name: 'scenes', schema: 'core_schema' })
@Index(['scriptId', 'number'], { unique: true })
export class Scene extends BaseEntity {
  @Column()
  scriptId: string;

  @ManyToOne(() => Script, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scriptId' })
  script: Script;

  @Column()
  @Index()
  number: number;

  @Column({ nullable: true })
  heading: string | null; // e.g., INT. LOCATION - DAY

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ type: 'jsonb', nullable: true })
  pages: number[] | null; // Array of page numbers where this scene occurs (e.g., [5, 6, 7] or [10])

  @ManyToMany(() => Character, (character) => character.scenes)
  @JoinTable({
    name: 'character_scenes',
    schema: 'core_schema',
    joinColumn: { name: 'sceneId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'characterId', referencedColumnName: 'id' },
  })
  characters: Character[];

  /**
   * Scene elements in script order — dialogues, action lines, and parentheticals.
   *
   * The `type` field distinguishes element kinds:
   * - `dialogue`: A character's spoken lines (has characterName + lines)
   * - `action`: Stage directions / action lines (characterName is null)
   * - `parenthetical`: Actor direction within dialogue (has characterName)
   *
   * Backward compatible: existing entries without a `type` field default to `dialogue`.
   *
   * Structure example:
   * [
   *   { "type": "dialogue", "characterId": "uuid", "characterName": "JOHN", "lines": ["How are you?"] },
   *   { "type": "action", "characterName": null, "lines": ["John slams his fist on the table."] },
   *   { "type": "dialogue", "characterId": "uuid", "characterName": "JANE", "lines": ["You left me no choice."] },
   *   { "type": "parenthetical", "characterName": "JANE", "lines": ["(whispering)"] },
   * ]
   */
  @Column({ type: 'jsonb', nullable: true })
  dialogues: Array<{
    type?: 'dialogue' | 'action' | 'parenthetical';
    characterId?: string | null;
    characterName: string | null;
    lines: string[];
    page?: number | null;
  }> | null;
}
