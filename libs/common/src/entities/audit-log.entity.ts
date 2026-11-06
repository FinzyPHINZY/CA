import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'audit_logs', schema: 'auth_schema' })
export class AuditLog extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  userId: string;

  @Column({ type: 'varchar', length: 255 })
  @Index()
  action: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  resourceType: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  resourceId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'text', nullable: true })
  userAgent: string | null;
}
