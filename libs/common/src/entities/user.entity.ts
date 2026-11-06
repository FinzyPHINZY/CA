import {
  Column,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Genre } from './genre.entity';
import { Permission } from './permission.entity';
import { DisplayPreferences, SessionSettings, UserRoleEntity } from '..';

@Entity({ name: 'users', schema: 'auth_schema' })
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index()
  email?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  password?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  fullName?: string;

  @Column({ type: 'varchar', length: 100, nullable: true, unique: true })
  @Index()
  phoneNumber?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  avatar?: string;

  @Column({ type: 'uuid', name: 'roleId' })
  @Index()
  roleId: string;

  @ManyToOne(() => UserRoleEntity, { nullable: false, eager: true })
  @JoinColumn({ name: 'roleId' })
  role: UserRoleEntity;

  @Column({ type: 'varchar', length: 100, default: 'UTC' })
  timezone: string;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  @Index()
  googleId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, unique: true })
  @Index()
  appleId?: string;

  @Column({ type: 'boolean', default: false })
  emailVerified: boolean;

  @Column({ type: 'varchar', length: 6, nullable: true })
  emailVerificationCode?: string;

  @Column({ type: 'timestamp', nullable: true })
  emailVerificationCodeExpiry?: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date;

  @ManyToMany(() => Genre, (genre) => genre.users, { cascade: ['insert'] })
  @JoinTable({
    name: 'user_genres',
    schema: 'auth_schema',
    joinColumn: { name: 'user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'genre_id', referencedColumnName: 'id' },
  })
  genres?: Genre[];

  @ManyToMany(() => Permission, { cascade: false, eager: true })
  @JoinTable({
    name: 'user_permissions',
    schema: 'auth_schema',
    joinColumn: { name: 'userId', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permissionId', referencedColumnName: 'id' },
  })
  permissions?: Permission[];

  @Column({ type: 'integer', nullable: true, default: 1 })
  @Index()
  yearsOfExperience?: number;

  @Column({ type: 'text', nullable: true })
  bio?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index()
  location?: string;

  @Column({ type: 'boolean', default: false })
  @Index()
  disabled: boolean;

  @Column({ type: 'text', nullable: true })
  deactivationReason?: string;

  @Column({ type: 'timestamp', nullable: true })
  deactivatedAt?: Date;

  @Column({ type: 'text', nullable: true })
  reactivationReason?: string;

  @Column({ type: 'timestamp', nullable: true })
  reactivatedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  bannedAt?: Date;

  @Column({ type: 'text', nullable: true })
  banReason?: string;

  /** Secret token used to authenticate the webcal feed URL. Generated on first request; rotate to invalidate old URL. */
  @Column({ type: 'varchar', length: 64, nullable: true, unique: true })
  feedToken?: string;

  @Column({
    type: 'decimal',
    precision: 3,
    scale: 2,
    default: 0,
    name: 'avg_rating',
  })
  avgRating: number;

  @Column({ type: 'integer', default: 0, name: 'total_reviews' })
  totalReviews: number;

  @Column({ type: 'jsonb', nullable: true })
  displayPreferences: DisplayPreferences | null;

  @Column({ type: 'jsonb', nullable: true })
  defaultSessionSettings: SessionSettings | null;

  get roles(): string[] {
    return this.role?.code ? [this.role.code] : [];
  }
}
