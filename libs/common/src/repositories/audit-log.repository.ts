import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class AuditLogRepository extends BaseRepository<AuditLog> {
  constructor(dataSource: DataSource) {
    super(AuditLog, dataSource.manager);
  }
}
