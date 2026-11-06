import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../entities/audit-log.entity';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { AuditService } from './audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog])],
  providers: [AuditLogRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
