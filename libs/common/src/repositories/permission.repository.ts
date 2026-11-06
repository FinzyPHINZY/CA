import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Permission } from '../entities/permission.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class PermissionRepository extends BaseRepository<Permission> {
  constructor(dataSource: DataSource) {
    super(Permission, dataSource.manager);
  }

  async findByCode(code: string): Promise<Permission | null> {
    return this.findOne({ where: { code } });
  }

  async findByCodes(codes: string[]): Promise<Permission[]> {
    if (!codes.length) return [];
    return this.find({ where: codes.map((code) => ({ code })) });
  }
}
