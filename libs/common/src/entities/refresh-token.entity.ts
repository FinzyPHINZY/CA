import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

@Entity({ name: 'refresh_tokens', schema: 'auth_schema' })
export class RefreshToken extends BaseEntity {
  @Column({ type: 'uuid' })
  @Index()
  userId: string;

  @Column({ type: 'varchar', length: 64 })
  @Index()
  tokenHash: string;

  @Column({ type: 'varchar', length: 36 })
  @Index()
  family: string;

  @Column({ type: 'timestamp' })
  expiresAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  revokedAt?: Date;
}
