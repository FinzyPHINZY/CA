import { BaseEntity, MediaType } from '@app/common';
import { Column, Entity } from 'typeorm';
@Entity({ name: 'media', schema: 'media_schema' })
export class Media extends BaseEntity {
  @Column({ type: 'enum', enum: MediaType })
  type: MediaType;

  @Column()
  url: string;

  @Column()
  size: number;

  @Column()
  userId: string;

  @Column({ name: 'durationMs', type: 'integer', nullable: true })
  durationMs: number | null;
}
