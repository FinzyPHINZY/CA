import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

@Entity({ name: 'user_roles', schema: 'auth_schema' })
export class UserRoleEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 100, unique: true })
  @Index()
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'boolean', default: false })
  @Index()
  isSystem: boolean;

  @OneToMany(() => User, (user) => user.role)
  users?: User[];
}
