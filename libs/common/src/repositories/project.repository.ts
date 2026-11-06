import { Injectable } from '@nestjs/common';
import { DataSource, FindManyOptions, ILike } from 'typeorm';
import { Project } from '../entities/project.entity';
import { BaseRepository } from './base.repository';
import { ProjectStatus, ScriptStatus } from '../enums/enums';

export interface ProjectPaginationOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: ProjectStatus;
  sortBy?: 'createdAt' | 'updatedAt' | 'title';
  sortOrder?: 'ASC' | 'DESC';
}

@Injectable()
export class ProjectRepository extends BaseRepository<Project> {
  constructor(dataSource: DataSource) {
    super(Project, dataSource.manager);
  }

  /**
   * Find project by ID or throw error
   */
  async findByIdOrFail(id: string): Promise<Project> {
    return super.findByIdOrFail(id);
  }

  /**
   * Find projects by user ID
   * @param userId - User ID
   * @param loadRelations - Whether to load media and script relations (default: false)
   * @param status - Optional status filter
   */
  async findByUserId(
    userId: string,
    loadRelations = false,
    status?: ProjectStatus,
  ): Promise<Project[]> {
    const where: any = { userId };
    if (status) {
      where.status = status;
    }
    return this.findManyBy(where, {
      order: { createdAt: 'DESC' },
      ...(loadRelations && { relations: ['media', 'script'] }),
    });
  }

  /**
   * Find projects by user ID with pagination, search, sort, and filters
   */
  async findByUserIdWithPagination(
    userId: string,
    options: ProjectPaginationOptions = {},
  ): Promise<{ data: Project[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      status,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    // Build base where condition
    const baseWhere: any = { userId };
    if (status) {
      baseWhere.status = status;
    }

    // Build search conditions
    let where: any;
    if (search) {
      // Use OR condition for search across title and description
      where = [
        {
          ...baseWhere,
          title: ILike(`%${search}%`),
        },
        {
          ...baseWhere,
          description: ILike(`%${search}%`),
        },
      ];
    } else {
      where = baseWhere;
    }

    const findOptions: FindManyOptions<Project> = {
      where,
      order: { [sortBy]: sortOrder },
      skip: (page - 1) * limit,
      take: limit,
      withDeleted: false, // Explicitly exclude soft-deleted projects
    };

    const [data, total] = await this.findAndCount(findOptions);

    return {
      data,
      total,
      page,
      limit,
    };
  }

  /**
   * Find projects by script ID (deprecated - use script.projectId instead)
   * This method is kept for backward compatibility but may not work correctly
   * as projects no longer have a direct scriptId field
   */
  async findByScriptId(scriptId: string): Promise<Project[]> {
    // Projects are now related to scripts via OneToMany, so we need to find via script
    // This is a placeholder - actual implementation should query via Script entity
    return [];
  }

  /**
   * Find projects by script ID with pagination, search, sort, and filters
   * Note: This method may not work correctly as projects no longer have scriptId
   */
  async findByScriptIdWithPagination(
    scriptId: string,
    options: ProjectPaginationOptions = {},
  ): Promise<{ data: Project[]; total: number; page: number; limit: number }> {
    const { page = 1, limit = 10 } = options;

    // Projects are now related to scripts via OneToMany
    // This is a placeholder - actual implementation should query via Script entity
    return {
      data: [],
      total: 0,
      page,
      limit,
    };
  }

  /**
   * Find project by user ID and script ID
   */
  async findByUserIdAndScriptId(
    userId: string,
    scriptId: string,
  ): Promise<Project[]> {
    return this.findManyBy({ userId, scriptId } as any, {
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Create a new project
   */
  async createProject(projectData: Partial<Project>): Promise<Project> {
    return this.createEntity(projectData);
  }

  /**
   * Update project
   */
  async updateProject(
    id: string,
    projectData: Partial<Project>,
  ): Promise<Project | null> {
    return this.updateByIdAndReturn(id, projectData);
  }

  /**
   * Delete project by ID
   */
  async deleteProject(id: string): Promise<void> {
    await this.hardDelete(id);
  }

  /**
   * Count projects by user ID
   */
  async countByUserId(userId: string, status?: ProjectStatus): Promise<number> {
    const where: any = { userId };
    if (status) {
      where.status = status;
    }
    return this.countAll({ where });
  }

  /**
   * Find the last pending project for a user
   */
  async findLastPendingByUserId(userId: string): Promise<Project | null> {
    return this.createQueryBuilder('project')
      .innerJoin(
        'core_schema.scripts',
        'script',
        'script."projectId" = project.id AND script."deletedAt" IS NULL',
      )
      .where('project."userId" = :userId', { userId })
      .andWhere('project."deletedAt" IS NULL')
      .andWhere('script.status IN (:...pendingStatuses)', {
        pendingStatuses: [ScriptStatus.UPLOADED, ScriptStatus.PROCESSING],
      })
      .orderBy('project."createdAt"', 'DESC')
      .getOne();
  }
}
