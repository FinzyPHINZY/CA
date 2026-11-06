import { Injectable } from '@nestjs/common';
import { DataSource, IsNull, LessThan, Not } from 'typeorm';
import { SessionSharedFile } from '../entities/session-shared-file.entity';
import { SessionSharedFileAnalysisStatus } from '../enums/session-shared-file.enum';
import { BaseRepository } from './base.repository';

@Injectable()
export class SessionSharedFileRepository extends BaseRepository<SessionSharedFile> {
  constructor(dataSource: DataSource) {
    super(SessionSharedFile, dataSource.manager);
  }

  async findActiveByRehearsalId(
    rehearsalId: string,
  ): Promise<SessionSharedFile[]> {
    return this.find({
      where: { rehearsalId },
      order: { createdAt: 'ASC' },
      withDeleted: false,
    });
  }

  async countActiveByRehearsalId(rehearsalId: string): Promise<number> {
    return this.count({
      where: { rehearsalId },
      withDeleted: false,
    });
  }

  // Idempotency: same (rehearsalId, uploaderUserId, clientUploadId) → existing row.
  // Used by attach() to short-circuit FE retries.
  async findByClientUploadId(
    rehearsalId: string,
    uploaderUserId: string,
    clientUploadId: string,
  ): Promise<SessionSharedFile | null> {
    return this.findOne({
      where: { rehearsalId, uploaderUserId, clientUploadId },
      withDeleted: false,
    });
  }

  // Cross-session analysis cache. Returns the most recently completed analysis
  // for a given content hash, regardless of which session it ran in.
  async findCompletedAnalysisByHash(
    contentHash: string,
  ): Promise<SessionSharedFile | null> {
    return this.findOne({
      where: {
        contentHash,
        analysisStatus: SessionSharedFileAnalysisStatus.COMPLETED,
      },
      order: { analysisCompletedAt: 'DESC' },
      withDeleted: true, // cache hit on a soft-deleted row is still valid
    });
  }

  // Bulk soft-delete at session end. Sets deletedAt for all active rows on the
  // rehearsal in one statement. Returns affected count for logging.
  async softDeleteAllByRehearsalId(rehearsalId: string): Promise<number> {
    const result = await this.createQueryBuilder()
      .softDelete()
      .where('rehearsalId = :rehearsalId', { rehearsalId })
      .andWhere('deletedAt IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  // Retention cron query: rows soft-deleted more than `graceMs` ago.
  // Caller iterates these to delete S3 objects + hard-delete rows.
  async findExpiredSoftDeleted(
    cutoff: Date,
    limit: number = 100,
  ): Promise<SessionSharedFile[]> {
    return this.find({
      where: {
        deletedAt: LessThan(cutoff) as any,
      },
      withDeleted: true,
      take: limit,
      order: { deletedAt: 'ASC' },
    });
  }

  async hardDeleteByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.createQueryBuilder()
      .delete()
      .whereInIds(ids)
      .execute();
    return result.affected ?? 0;
  }

  async findActiveById(id: string): Promise<SessionSharedFile | null> {
    return this.findOne({
      where: { id, deletedAt: IsNull() as any },
      withDeleted: false,
    });
  }

  async findPendingByContentHashExcluding(
    contentHash: string,
    excludeId: string,
  ): Promise<SessionSharedFile | null> {
    return this.findOne({
      where: {
        contentHash,
        analysisStatus: SessionSharedFileAnalysisStatus.PROCESSING,
        id: Not(excludeId) as any,
      },
      withDeleted: false,
    });
  }
}
