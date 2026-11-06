/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { RehearsalEventType } from '../enums/studio.enum';
import { BaseEntity } from './base.entity';
import { Rehersal } from './rehersal.entity';

@Entity({ name: 'rehearsal_events', schema: 'studio_schema' })
@Index(['rehearsalId', 'eventType'])
export class RehearsalEvent extends BaseEntity {
  @Column({ nullable: false })
  rehearsalId: string;

  @ManyToOne(() => Rehersal, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'rehearsalId' })
  rehearsal: Rehersal;

  @Column({
    type: 'enum',
    enum: RehearsalEventType,
    nullable: false,
  })
  eventType: RehearsalEventType;

  @Column({ type: 'int', nullable: true })
  lineIndex: number | null;

  @Column({ nullable: true })
  characterId: string | null;

  // flexible event data: transcript, confidence score, response time, etc.
  @Column({ type: 'jsonb', nullable: true })
  data: Record<string, any> | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp: Date;
}
