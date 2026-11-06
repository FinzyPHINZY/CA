import { Column, Entity, Index } from 'typeorm';
import { UsageService } from '../enums/studio.enum';
import { BaseEntity } from './base.entity';

@Entity({ name: 'usage_records', schema: 'billing_schema' })
@Index(['userId', 'service', 'billingPeriodStart'])
export class UsageRecord extends BaseEntity {
  // User this usage is billed to.
  // Plain UUID — user data fetched via API composition from auth service.
  @Column({ nullable: false })
  @Index()
  userId: string;

  @Column({
    type: 'enum',
    enum: UsageService,
    nullable: false,
  })
  service: UsageService;

  @Column({ type: 'bigint', nullable: false })
  quantity: number;

  @Column({ type: 'varchar', nullable: false })
  unit: string;

  // Linked rehearsal ID (nullable — not all usage is tied to a rehearsal).
  // Plain UUID — Rehearsal lives in studio_schema.
  @Column({ type: 'uuid', nullable: true })
  rehearsalId: string | null;

  // Linked recording ID (nullable — not all usage is tied to a recording).
  // Plain UUID — Recording lives in studio_schema.
  @Column({ type: 'uuid', nullable: true })
  recordingId: string | null;

  @Column({ type: 'timestamp', nullable: false })
  billingPeriodStart: Date;

  @Column({ type: 'timestamp', nullable: false })
  billingPeriodEnd: Date;
}
