import { Injectable } from '@nestjs/common';
import { AuditLogAction } from '../enums/audit-log-action.enum';
import { AuditLogRepository } from '../repositories/audit-log.repository';

export interface AuditParams {
  userId: string;
  action: AuditLogAction | string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly auditLogRepository: AuditLogRepository) {}

  async log(params: AuditParams): Promise<void> {
    await this.auditLogRepository.createEntity({
      userId: params.userId,
      action: params.action,
      resourceType: params.resourceType ?? null,
      resourceId: params.resourceId ?? null,
      metadata: params.metadata ?? null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });
  }
}
