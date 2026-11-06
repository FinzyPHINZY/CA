import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Scene } from './scene.entity';
import { Script } from './script.entity';

@Entity({ name: 'script_chunks', schema: 'ai_schema' })
@Index(['scriptId', 'chunkIndex'], { unique: true })
@Index(['scriptId', 'sceneNumber'])
export class ScriptChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  scriptId: string;

  @ManyToOne(() => Script, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'scriptId' })
  script: Script;

  @Column({ nullable: true })
  sceneId: string | null;

  @ManyToOne(() => Scene, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'sceneId' })
  scene: Scene;

  @Column({ type: 'int', nullable: true })
  sceneNumber: number | null;

  @Column({ type: 'int' })
  chunkIndex: number;

  @Column({ type: 'int', nullable: true })
  pageStart: number | null;

  @Column({ type: 'int', nullable: true })
  pageEnd: number | null;

  @Column({ type: 'text', array: true, nullable: true })
  characters: string[] | null;

  @Column({ type: 'text', nullable: true })
  location: string | null;

  @Column({ type: 'text', nullable: true })
  timeOfDay: string | null;

  @Column({ type: 'text' })
  text: string;

  @Column({ type: 'int' })
  tokenCount: number;

  // Stored as vector(768) in Postgres via migration. TypeORM doesn't have a
  // native vector type, so we declare as varchar and use a transformer to
  // convert between number[] (app) and the pgvector literal `[a,b,c]` (db).
  // Similarity retrieval still goes through raw SQL with pgvector operators.
  @Column({
    type: 'varchar',
    transformer: {
      to: (v: number[] | null): string | null =>
        v && v.length > 0 ? `[${v.join(',')}]` : null,
      from: (v: string | number[] | null): number[] | null => {
        if (v == null) return null;
        if (Array.isArray(v)) return v.map(Number);
        return v.replace(/^\[|\]$/g, '').split(',').map(Number);
      },
    },
  })
  embedding: number[];

  @Column({ type: 'text' })
  contentHash: string;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;
}
