/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UsageRecord } from '../entities/usage-record.entity';
import { UsageService } from '../enums/studio.enum';
import { BaseRepository } from './base.repository';

@Injectable()
export class UsageRecordRepository extends BaseRepository<UsageRecord> {
  constructor(dataSource: DataSource) {
    super(UsageRecord, dataSource.manager);
  }

  async findByUserId(userId: string): Promise<UsageRecord[]> {
    return this.findManyBy({ userId } as any, {
      order: { createdAt: 'DESC' },
      withDeleted: false,
    });
  }

  async findByUserIdAndService(
    userId: string,
    service: UsageService,
  ): Promise<UsageRecord[]> {
    return this.findManyBy({ userId, service } as any, {
      order: { createdAt: 'DESC' },
      withDeleted: false,
    });
  }

  // Sum usage for a user + service within a billing period.
  async sumUsageForPeriod(
    userId: string,
    service: UsageService,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    const result = await this.createQueryBuilder('usage')
      .select('COALESCE(SUM(usage.quantity), 0)', 'total')
      .where('usage.userId = :userId', { userId })
      .andWhere('usage.service = :service', { service })
      .andWhere('usage.billingPeriodStart >= :periodStart', { periodStart })
      .andWhere('usage.billingPeriodEnd <= :periodEnd', { periodEnd })
      .andWhere('usage.deletedAt IS NULL')
      .getRawOne();

    return parseInt(result?.total ?? '0', 10);
  }
}
