import { Column, Entity, Index } from 'typeorm';
import { AnalysisOutboxStatus } from '../enums/enums';
import { BaseEntity } from './base.entity';

@Entity({ name: 'analysis_outbox_jobs', schema: 'core_schema' })
@Index('IDX_analysis_outbox_status_nextAttemptAt', ['status', 'nextAttemptAt'])
@Index('IDX_analysis_outbox_scriptId', ['scriptId'])
@Index('IDX_analysis_outbox_taskId', ['taskId'], { unique: true })
export class AnalysisOutboxJob extends BaseEntity {
  @Column({ length: 100 })
  eventType: string;

  @Column()
  projectId: string;

  @Column()
  scriptId: string;

  @Column()
  taskId: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: AnalysisOutboxStatus.PENDING,
  })
  status: AnalysisOutboxStatus;

  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ type: 'timestamp', nullable: true })
  lastAttemptAt: Date | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  nextAttemptAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}
