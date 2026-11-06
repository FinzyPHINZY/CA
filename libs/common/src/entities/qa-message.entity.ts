import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { QaConversation } from './qa-conversation.entity';

export enum QaMessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export enum QaQueryClass {
  LOOKUP = 'LOOKUP',
  AGGREGATE = 'AGGREGATE',
  STRUCTURAL = 'STRUCTURAL',
  ANALYTICAL = 'ANALYTICAL',
  META = 'META',
  OFF_TOPIC = 'OFF_TOPIC',
}

@Entity({ name: 'qa_messages', schema: 'ai_schema' })
@Index(['conversationId', 'createdAt'])
export class QaMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  conversationId: string;

  @ManyToOne(() => QaConversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: QaConversation;

  @Column({ type: 'enum', enum: QaMessageRole })
  role: QaMessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'enum', enum: QaQueryClass, nullable: true })
  queryClass: QaQueryClass | null;

  @Column({ type: 'jsonb', nullable: true })
  citations: Array<{
    sceneId: string;
    sceneNumber: number;
    pageStart: number | null;
    pageEnd: number | null;
    snippet: string;
  }> | null;

  @Column({ type: 'jsonb', nullable: true })
  retrievalMetadata: Record<string, any> | null;

  @Column({ type: 'text', nullable: true })
  model: string | null;

  @Column({ type: 'int', nullable: true })
  latencyMs: number | null;

  @Column({ type: 'int', nullable: true })
  tokenInput: number | null;

  @Column({ type: 'int', nullable: true })
  tokenOutput: number | null;

  @Column({ type: 'smallint', nullable: true })
  userFeedback: number | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;
}
