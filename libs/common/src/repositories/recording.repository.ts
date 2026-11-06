/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Injectable } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { Recording } from '../entities/recording.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class RecordingRepository extends BaseRepository<Recording> {
  constructor(dataSource: DataSource) {
    super(Recording, dataSource.manager);
  }

  // find recording by ID with all relations
  // note: user data should be fetched via API composition from auth service
  async findById(id: string): Promise<Recording | null> {
    return this.findOne({
      where: { id },
      relations: ['project', 'script', 'scene', 'takes', 'mediaResources'],
      withDeleted: false, // explicitly exclude soft-deleted recordings
    });
  }

  // find recordings by project ID
  async findByProjectId(projectId: string): Promise<Recording[]> {
    return this.findManyBy({ projectId } as any, {
      order: { createdAt: 'DESC' },
      relations: ['scene', 'takes', 'mediaResources'],
      withDeleted: false, // explicitly exclude soft-deleted recordings
    });
  }

  // find recordings by scene ID
  async findBySceneId(sceneId: string): Promise<Recording[]> {
    return this.findManyBy({ sceneId } as any, {
      order: { createdAt: 'DESC' },
      relations: ['project', 'takes', 'mediaResources'],
      withDeleted: false, // explicitly exclude soft-deleted recordings
    });
  }

  // find recordings by user ID
  async findByUserId(userId: string): Promise<Recording[]> {
    return this.findManyBy({ userId } as any, {
      order: { createdAt: 'DESC' },
      relations: ['project', 'script', 'scene', 'takes', 'mediaResources'],
      withDeleted: false, // explicitly exclude soft-deleted recordings
    });
  }

  // find recordings by project and scene ID
  async findByProjectIdAndSceneId(
    projectId: string,
    sceneId: string,
  ): Promise<Recording[]> {
    return this.findManyBy({ projectId, sceneId } as any, {
      order: { createdAt: 'DESC' },
      relations: ['takes', 'mediaResources'],
      withDeleted: false, // explicitly exclude soft-deleted recordings
    });
  }

  // find recordings by project ID with pagination, search, sort, and filter
  async findByProjectIdWithPagination(
    projectId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{
    data: Recording[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('recording')
      .where('recording.projectId = :projectId', { projectId })
      .andWhere('recording.deletedAt IS NULL') // exclude soft-deleted recordings (backwards compatible: includes existing records with deletedAt = NULL)
      .leftJoinAndSelect('recording.scene', 'scene')
      .leftJoinAndSelect('recording.takes', 'takes')
      .leftJoinAndSelect('recording.mediaResources', 'mediaResources')
      .orderBy(`recording.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(recording.titleCard) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(recording.summary) LIKE LOWER(:search)', {
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

  /**
   * Find recordings by script ID with pagination, search, sort, and filter
   */
  async findByScriptIdWithPagination(
    scriptId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{
    data: Recording[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('recording')
      .where('recording.scriptId = :scriptId', { scriptId })
      .andWhere('recording.deletedAt IS NULL')
      .leftJoinAndSelect('recording.project', 'project')
      .leftJoinAndSelect('recording.scene', 'scene')
      .leftJoinAndSelect('recording.takes', 'takes')
      .leftJoinAndSelect('recording.mediaResources', 'mediaResources')
      .orderBy(`recording.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(recording.titleCard) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(recording.summary) LIKE LOWER(:search)', {
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

  // find recordings by scene ID with pagination, search, sort, and filter
  async findBySceneIdWithPagination(
    sceneId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{
    data: Recording[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('recording')
      .where('recording.sceneId = :sceneId', { sceneId })
      .andWhere('recording.deletedAt IS NULL') // exclude soft-deleted recordings (backwards compatible: includes existing records with deletedAt = NULL)
      .leftJoinAndSelect('recording.project', 'project')
      .leftJoinAndSelect('recording.takes', 'takes')
      .leftJoinAndSelect('recording.mediaResources', 'mediaResources')
      .orderBy(`recording.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(recording.titleCard) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(recording.summary) LIKE LOWER(:search)', {
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

  // find recordings by user ID with pagination, search, sort, and filter
  async findByUserIdWithPagination(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
      type?: string;
      mode?: string;
      status?: string;
    } = {},
  ): Promise<{
    data: Recording[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
      type,
      mode,
      status,
    } = options;

    const queryBuilder = this.createQueryBuilder('recording')
      .where('recording.userId = :userId', { userId })
      .andWhere('recording.deletedAt IS NULL') // exclude soft-deleted recordings (backwards compatible: includes existing records with deletedAt = NULL)
      .leftJoinAndSelect('recording.project', 'project')
      .leftJoinAndSelect('recording.script', 'script')
      .leftJoinAndSelect('recording.scene', 'scene')
      .leftJoinAndSelect('recording.takes', 'takes')
      .leftJoinAndSelect('recording.mediaResources', 'mediaResources')
      .leftJoinAndSelect('recording.rehearsal', 'rehearsal')
      .leftJoinAndSelect('rehearsal.booking', 'booking')
      .orderBy(`recording.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(recording.titleCard) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(recording.summary) LIKE LOWER(:search)', {
            search: `%${search}%`,
          });
        }),
      );
    }

    if (type) {
      queryBuilder.andWhere('recording.type = :type', { type });
    }

    if (mode) {
      queryBuilder.andWhere('recording.mode = :mode', { mode });
    }

    if (status) {
      queryBuilder.andWhere('recording.status = :status', { status });
    }

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
    };
  }

  // find recordings by project and scene ID with pagination, search, sort, and filter
  async findByProjectIdAndSceneIdWithPagination(
    projectId: string,
    sceneId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{
    data: Recording[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('recording')
      .where('recording.projectId = :projectId', { projectId })
      .andWhere('recording.sceneId = :sceneId', { sceneId })
      .andWhere('recording.deletedAt IS NULL') // exclude soft-deleted recordings (backwards compatible: includes existing records with deletedAt = NULL)
      .leftJoinAndSelect('recording.takes', 'takes')
      .leftJoinAndSelect('recording.mediaResources', 'mediaResources')
      .orderBy(`recording.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(recording.titleCard) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(recording.summary) LIKE LOWER(:search)', {
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

  // count recordings by script ID
  async countByScriptId(scriptId: string): Promise<number> {
    return this.countAll({ where: { scriptId } as any });
  }

  // find recordings by rehearsal ID with pagination, search, sort, and filter
  async findByRehearsalIdWithPagination(
    rehearsalId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{
    data: Recording[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('recording')
      .where('recording.rehearsalId = :rehearsalId', { rehearsalId })
      .andWhere('recording.deletedAt IS NULL')
      .leftJoinAndSelect('recording.scene', 'scene')
      .leftJoinAndSelect('recording.takes', 'takes')
      .leftJoinAndSelect('recording.mediaResources', 'mediaResources')
      .orderBy(`recording.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(recording.titleCard) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(recording.summary) LIKE LOWER(:search)', {
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
