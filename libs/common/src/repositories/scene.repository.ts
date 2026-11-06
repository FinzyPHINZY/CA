import { Injectable } from '@nestjs/common';
import { DataSource, Brackets } from 'typeorm';
import { Scene } from '../entities/scene.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class SceneRepository extends BaseRepository<Scene> {
  constructor(dataSource: DataSource) {
    super(Scene, dataSource.manager);
  }

  /**
   * Find scene by ID
   */
  async findById(id: string): Promise<Scene | null> {
    return super.findById(id);
  }

  /**
   * Find scene by ID or throw error
   */
  async findByIdOrFail(id: string): Promise<Scene> {
    return super.findByIdOrFail(id);
  }

  /**
   * Find scene by ID with characters loaded
   */
  async findByIdWithCharacters(id: string): Promise<Scene | null> {
    return this.createQueryBuilder('scene')
      .where('scene.id = :id', { id })
      .andWhere('scene.deletedAt IS NULL')
      .leftJoinAndSelect(
        'scene.characters',
        'characters',
        'characters.deletedAt IS NULL',
      )
      .getOne();
  }

  /**
   * Find scenes by script ID
   */
  async findByScriptId(scriptId: string): Promise<Scene[]> {
    return this.findManyBy({ scriptId } as any, {
      order: { number: 'ASC' },
    });
  }

  /**
   * Find scene by script ID and scene number
   */
  async findByScriptIdAndNumber(
    scriptId: string,
    number: number,
  ): Promise<Scene | null> {
    return this.findOneBy({ scriptId, number } as any);
  }

  /**
   * Find scenes by script ID with characters loaded
   */
  async findByScriptIdWithCharacters(scriptId: string): Promise<Scene[]> {
    return this.findManyBy({ scriptId } as any, {
      relations: ['characters'],
      order: { number: 'ASC' },
    });
  }

  /**
   * Create a new scene
   */
  async createScene(sceneData: Partial<Scene>): Promise<Scene> {
    return this.createEntity(sceneData);
  }

  /**
   * Create multiple scenes
   */
  async createScenes(scenesData: Partial<Scene>[]): Promise<Scene[]> {
    return this.createMany(scenesData);
  }

  /**
   * Update scene
   */
  async updateScene(
    id: string,
    sceneData: Partial<Scene>,
  ): Promise<Scene | null> {
    return this.updateByIdAndReturn(id, sceneData);
  }

  /**
   * Soft delete scene by ID
   */
  async deleteScene(id: string): Promise<void> {
    await this.softRemoveById(id);
  }

  /**
   * Soft delete all scenes for a script
   */
  async deleteByScriptId(scriptId: string): Promise<void> {
    const scenes = await this.findManyBy({ scriptId } as any);
    if (scenes.length > 0) {
      await this.softRemove(scenes);
    }
  }

  /**
   * Count scenes by script ID
   */
  async countByScriptId(scriptId: string): Promise<number> {
    return this.countAll({ where: { scriptId } as any });
  }

  /**
   * Find scenes by script ID with pagination, search, sort, and filter
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
  ): Promise<{ data: Scene[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'number',
      sortOrder = 'ASC',
    } = options;

    const queryBuilder = this.createQueryBuilder('scene')
      .where('scene.scriptId = :scriptId', { scriptId })
      .andWhere('scene.deletedAt IS NULL') // Exclude soft-deleted scenes (backwards compatible: includes existing records with deletedAt = NULL)
      .leftJoinAndSelect(
        'scene.characters',
        'characters',
        'characters.deletedAt IS NULL',
      )
      .orderBy(`scene.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(scene.heading) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(scene.summary) LIKE LOWER(:search)', {
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
   * Find unique scenes by task ID with pagination, search, sort, and filter
   * Returns unique scenes from the script associated with the task
   */
  async findByTaskIdWithPagination(
    taskId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{ data: Scene[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'number',
      sortOrder = 'ASC',
    } = options;

    const queryBuilder = this.createQueryBuilder('scene')
      .innerJoin('scene.script', 'script')
      .where('script.taskId = :taskId', { taskId })
      .andWhere('scene.deletedAt IS NULL')
      .andWhere('script.deletedAt IS NULL')
      .leftJoinAndSelect(
        'scene.characters',
        'characters',
        'characters.deletedAt IS NULL',
      )
      .orderBy(`scene.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(scene.heading) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(scene.summary) LIKE LOWER(:search)', {
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
   * Find unique scenes by project ID with pagination, search, sort, and filter
   * Returns unique scenes from all scripts in the project (deduplicated by scene ID)
   */
  async findByProjectIdWithPagination(
    projectId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{ data: Scene[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'number',
      sortOrder = 'ASC',
    } = options;

    const queryBuilder = this.createQueryBuilder('scene')
      .innerJoin('scene.script', 'script')
      .where('script.projectId = :projectId', { projectId })
      .andWhere('scene.deletedAt IS NULL')
      .andWhere('script.deletedAt IS NULL')
      .leftJoinAndSelect(
        'scene.characters',
        'characters',
        'characters.deletedAt IS NULL',
      )
      .orderBy(`scene.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(scene.heading) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(scene.summary) LIKE LOWER(:search)', {
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
