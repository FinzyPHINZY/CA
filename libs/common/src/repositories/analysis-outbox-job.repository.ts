import { Injectable } from '@nestjs/common';
import { Brackets, DataSource, In } from 'typeorm';
import { AnalysisOutboxJob } from '../entities/analysis-outbox-job.entity';
import { AnalysisOutboxStatus } from '../enums/enums';
import { BaseRepository } from './base.repository';

interface FindProjectJobsOptions {
  status?: AnalysisOutboxStatus;
  includeDispatched?: boolean;
  onlyStuck?: boolean;
  limit?: number;
  staleBefore?: Date;
}

@Injectable()
export class AnalysisOutboxJobRepository extends BaseRepository<AnalysisOutboxJob> {
  constructor(dataSource: DataSource) {
    super(AnalysisOutboxJob, dataSource.manager);
  }

  async createJob(
    jobData: Partial<AnalysisOutboxJob>,
  ): Promise<AnalysisOutboxJob> {
    return this.createEntity(jobData);
  }

  async createJobs(
    jobsData: Partial<AnalysisOutboxJob>[],
  ): Promise<AnalysisOutboxJob[]> {
    return this.createMany(jobsData);
  }

  async claimDispatchableJobs(
    limit: number,
    staleAfterMs: number,
  ): Promise<AnalysisOutboxJob[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - staleAfterMs);

    return this.manager.transaction(async (manager) => {
      const repo = manager.getRepository(AnalysisOutboxJob);
      const jobs = await repo
        .createQueryBuilder('job')
        .where('job."deletedAt" IS NULL')
        .andWhere(
          new Brackets((qb) => {
            qb.where(
              'job.status IN (:...retryableStatuses) AND job."nextAttemptAt" <= :now',
              {
                retryableStatuses: [
                  AnalysisOutboxStatus.PENDING,
                  AnalysisOutboxStatus.FAILED,
                ],
                now,
              },
            ).orWhere(
              'job.status = :processingStatus AND job."lastAttemptAt" <= :staleBefore',
              {
                processingStatus: AnalysisOutboxStatus.PROCESSING,
                staleBefore,
              },
            );
          }),
        )
        .orderBy('job."createdAt"', 'ASC')
        .limit(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (jobs.length === 0) {
        return [];
      }

      const ids = jobs.map((job) => job.id);
      await repo
        .createQueryBuilder()
        .update(AnalysisOutboxJob)
        .set({
          status: AnalysisOutboxStatus.PROCESSING,
          lastAttemptAt: now,
          lastError: null,
          attempts: () => '"attempts" + 1',
        })
        .where({ id: In(ids) })
        .execute();

      return repo.find({
        where: { id: In(ids) },
        order: { createdAt: 'ASC' },
      });
    });
  }

  async markDispatched(id: string): Promise<void> {
    await this.update(id, {
      status: AnalysisOutboxStatus.DISPATCHED,
      dispatchedAt: new Date(),
      lastError: null,
    });
  }

  async markFailed(
    id: string,
    errorMessage: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.update(id, {
      status: AnalysisOutboxStatus.FAILED,
      lastError: errorMessage,
      nextAttemptAt,
    });
  }

  async getStatusCountsForProject(
    projectId: string,
  ): Promise<Record<AnalysisOutboxStatus, number>> {
    const rows = await this.createQueryBuilder('job')
      .select('job.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('job."projectId" = :projectId', { projectId })
      .andWhere('job."deletedAt" IS NULL')
      .groupBy('job.status')
      .getRawMany<{ status: AnalysisOutboxStatus; count: string }>();

    const counts = {
      [AnalysisOutboxStatus.PENDING]: 0,
      [AnalysisOutboxStatus.PROCESSING]: 0,
      [AnalysisOutboxStatus.DISPATCHED]: 0,
      [AnalysisOutboxStatus.FAILED]: 0,
    };

    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }

    return counts;
  }

  async findProjectJobsForDebug(
    projectId: string,
    options: FindProjectJobsOptions = {},
  ): Promise<AnalysisOutboxJob[]> {
    const {
      status,
      includeDispatched = false,
      onlyStuck = false,
      limit = 20,
      staleBefore,
    } = options;

    const query = this.createQueryBuilder('job')
      .where('job."projectId" = :projectId', { projectId })
      .andWhere('job."deletedAt" IS NULL');

    if (status) {
      query.andWhere('job.status = :status', { status });
    } else if (!includeDispatched) {
      query.andWhere('job.status != :dispatchedStatus', {
        dispatchedStatus: AnalysisOutboxStatus.DISPATCHED,
      });
    }

    if (onlyStuck) {
      query.andWhere(
        new Brackets((qb) => {
          qb.where('job.status = :failedStatus', {
            failedStatus: AnalysisOutboxStatus.FAILED,
          });

          if (staleBefore) {
            qb.orWhere(
              'job.status = :processingStatus AND job."lastAttemptAt" <= :staleBefore',
              {
                processingStatus: AnalysisOutboxStatus.PROCESSING,
                staleBefore,
              },
            ).orWhere(
              'job.status = :pendingStatus AND job."nextAttemptAt" <= :staleBefore',
              {
                pendingStatus: AnalysisOutboxStatus.PENDING,
                staleBefore,
              },
            );
          }
        }),
      );
    }

    return query
      .orderBy('job."updatedAt"', 'DESC')
      .addOrderBy('job."createdAt"', 'DESC')
      .limit(limit)
      .getMany();
  }
}
