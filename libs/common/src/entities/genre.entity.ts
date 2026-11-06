import { Column, Entity, Index, ManyToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

@Entity({ name: 'genres', schema: 'auth_schema' })
export class Genre extends BaseEntity {
  @Column({ type: 'varchar', length: 100, unique: true })
  @Index({ unique: true })
  name: string;

  @ManyToMany(() => User, (user) => user.genres)
  users?: User[];
}
