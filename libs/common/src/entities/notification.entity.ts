/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Column, Entity, Index } from 'typeorm';
import { NotificationType } from '../enums/notification-type.enum';
import { BaseEntity } from './base.entity';

@Entity({ name: 'notifications', schema: 'notifications_schema' })
export class Notification extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  recipientUserId: string;

  @Column({ type: 'varchar', length: 150 })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'boolean', default: false })
  read: boolean;

  @Column({ type: 'varchar', length: 50, default: NotificationType.GENERAL })
  @Index()
  notificationType: NotificationType;

  // script analysis specific fields
  @Column({ type: 'uuid', nullable: true })
  @Index()
  taskId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  scriptName: string | null;

  @Column({ type: 'integer', nullable: true })
  progress: number | null;

  @Column({ type: 'text', nullable: true })
  progressMessage: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  step: string | null;

  @Column({ type: 'integer', nullable: true })
  scriptIndex: number | null;

  @Column({ type: 'jsonb', nullable: true })
  resultMetadata: {
    status?: 'success' | 'failed';
    message?: string;
    error?: string;
  } | null;

  @Column({ type: 'jsonb', nullable: true })
  result: any | null;

  // additional metadata for flexibility
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}
