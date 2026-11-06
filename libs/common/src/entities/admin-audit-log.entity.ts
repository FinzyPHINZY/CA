import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'admin_audit_logs', schema: 'audit_schema' })
@Index('IDX_admin_audit_logs_action', ['action'])
@Index('IDX_admin_audit_logs_actorUserId', ['actorUserId'])
@Index('IDX_admin_audit_logs_resourceType', ['resourceType'])
@Index('IDX_admin_audit_logs_resourceId', ['resourceId'])
@Index('IDX_admin_audit_logs_createdAt', ['createdAt'])
export class AdminAuditLog extends BaseEntity {
  @Column({ type: 'uuid', nullable: true })
  actorUserId?: string | null;

  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ type: 'varchar', length: 100 })
  resourceType: string;

  @Column({ type: 'uuid', nullable: true })
  resourceId?: string | null;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @Column({ type: 'varchar', length: 100, nullable: true })
  ipAddress?: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent?: string | null;
}
