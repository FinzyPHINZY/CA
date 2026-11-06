import { Injectable } from '@nestjs/common';
import { DataSource, Brackets } from 'typeorm';
import { Script } from '../entities/script.entity';
import { BaseRepository } from './base.repository';
import { ScriptStatus } from '../enums/enums';

@Injectable()
export class ScriptRepository extends BaseRepository<Script> {
  constructor(dataSource: DataSource) {
    super(Script, dataSource.manager);
  }

  /**
   * Find script by ID
   */
  async findById(id: string): Promise<Script | null> {
    return super.findById(id);
  }

  /**
   * Find script by ID or throw error
   */
  async findByIdOrFail(id: string): Promise<Script> {
    return super.findByIdOrFail(id);
  }

  /**
   * Find scripts by user ID (author)
   */
  async findByUserId(userId: string): Promise<Script[]> {
    return this.findManyBy({ userId });
  }

  /**
   * Find scripts by author ID (alias for findByUserId)
   */
  async findByAuthorId(authorId: string): Promise<Script[]> {
    return this.findByUserId(authorId);
  }

  /**
   * Find scripts by status
   */
  async findByStatus(status: ScriptStatus): Promise<Script[]> {
    return this.findManyBy({ status } as any);
  }

  /**
   * Find scripts by analysis ID
   */
  async findByAnalysisId(analysisId: string): Promise<Script[]> {
    return this.findManyBy({ analysisId } as any);
  }

  /**
   * Find script by task ID
   */
  async findByTaskId(taskId: string): Promise<Script | null> {
    return this.findOneBy({ taskId } as any);
  }

  /**
   * Find scripts by project ID
   */
  async findByProjectId(projectId: string): Promise<Script[]> {
    return this.findManyBy({ projectId } as any, {
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Find a script by project ID and source media ID
   */
  async findByProjectIdAndSourceMediaId(
    projectId: string,
    sourceMediaId: string,
  ): Promise<Script | null> {
    return this.findOne({
      where: { projectId, sourceMediaId } as any,
      withDeleted: false,
    });
  }

  /**
   * Find script by file URL
   */
  async findByFileUrl(fileUrl: string): Promise<Script | null> {
    return this.findOneBy({ fileUrl } as any);
  }

  /**
   * Find script by project ID and content hash (for deduplication)
   */
  async findByProjectIdAndContentHash(
    projectId: string,
    contentHash: string,
  ): Promise<Script | null> {
    return this.findOne({
      where: { projectId, contentHash } as any,
      withDeleted: false,
    });
  }

  /**
   * Create a new script
   */
  async createScript(scriptData: Partial<Script>): Promise<Script> {
    return this.createEntity({
      ...scriptData,
      status: scriptData.status || ScriptStatus.UPLOADED,
    });
  }

  /**
   * Update script status
   */
  async updateStatus(id: string, status: ScriptStatus): Promise<Script | null> {
    return this.updateByIdAndReturn(id, { status } as any);
  }

  /**
   * Update script
   */
  async updateScript(
    id: string,
    scriptData: Partial<Script>,
  ): Promise<Script | null> {
    return this.updateByIdAndReturn(id, scriptData);
  }

  /**
   * Soft delete script by ID
   */
  async deleteScript(id: string): Promise<void> {
    await this.softRemoveById(id);
  }

  /**
   * Find scripts by author ID with pagination, search, sort, and filter
   */
  async findByAuthorIdWithPagination(
    authorId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: ScriptStatus;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{ data: Script[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('script')
      .where('script.userId = :authorId', { authorId })
      .andWhere('script.deletedAt IS NULL') // Exclude soft-deleted scripts (backwards compatible: includes existing records with deletedAt = NULL)
      .orderBy(`script.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (status) {
      queryBuilder.andWhere('script.status = :status', { status });
    }

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(script.title) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(script.content) LIKE LOWER(:search)', {
            search: `%${search}%`,
          });
        }),
      );
    }

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
    };
  }
}
