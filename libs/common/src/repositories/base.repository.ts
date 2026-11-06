import {
  Repository,
  FindOptionsWhere,
  FindManyOptions,
  FindOneOptions,
  SaveOptions,
  DeepPartial,
  UpdateResult,
  DeleteResult,
} from 'typeorm';
import { Logger } from '@nestjs/common';
import { BaseEntity } from '../entities/base.entity';

export abstract class BaseRepository<
  T extends BaseEntity,
> extends Repository<T> {
  private _logger?: Logger;

  /**
   * Get logger instance with the concrete repository class name as context
   * Logger is cached after first access
   */
  protected get logger(): Logger {
    if (!this._logger) {
      const context = this.constructor.name;
      this._logger = new Logger(context);
    }
    return this._logger;
  }
  /**
   * Find entity by ID
   *
   * Backwards compatible: Existing records with deletedAt = NULL are included.
   * Only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
   */
  async findById(id: string, options?: FindOneOptions<T>): Promise<T | null> {
    return this.findOne({
      where: { id } as FindOptionsWhere<T>,
      withDeleted: false, // Explicitly exclude soft-deleted entities (deletedAt IS NOT NULL)
      // Note: Records with deletedAt = NULL (existing data) are included by default
      ...options,
    });
  }

  /**
   * Find entity by ID or throw error
   *
   * Backwards compatible: Existing records with deletedAt = NULL are included.
   * Only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
   */
  async findByIdOrFail(id: string, options?: FindOneOptions<T>): Promise<T> {
    return this.findOneOrFail({
      where: { id } as FindOptionsWhere<T>,
      withDeleted: false, // Explicitly exclude soft-deleted entities (deletedAt IS NOT NULL)
      // Note: Records with deletedAt = NULL (existing data) are included by default
      ...options,
    });
  }

  /**
   * Find all entities (excluding soft-deleted)
   */
  async findAll(options?: FindManyOptions<T>): Promise<T[]> {
    return this.find({
      ...options,
      withDeleted: false,
    });
  }

  /**
   * Find entities with pagination
   */
  async findWithPagination(
    page: number = 1,
    limit: number = 10,
    options?: FindManyOptions<T>,
  ): Promise<{ data: T[]; total: number; page: number; limit: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await this.findAndCount({
      ...options,
      skip,
      take: limit,
      withDeleted: false,
    });

    return {
      data,
      total,
      page,
      limit,
    };
  }

  /**
   * Create and save entity
   */
  async createEntity(
    entityData: DeepPartial<T>,
    options?: SaveOptions,
  ): Promise<T> {
    this.logger.debug(`Creating entity: ${JSON.stringify(entityData)}`);
    const entity = this.create(entityData);
    const saved = await this.save(entity, options);
    this.logger.log(`Entity created with ID: ${saved.id}`);
    return saved;
  }

  /**
   * Create and save multiple entities
   */
  async createMany(
    entitiesData: DeepPartial<T>[],
    options?: SaveOptions,
  ): Promise<T[]> {
    this.logger.debug(`Creating ${entitiesData.length} entities`);
    const entities = this.create(entitiesData);
    const saved = await this.save(entities, options);
    this.logger.log(`Successfully created ${saved.length} entities`);
    return saved;
  }

  /**
   * Update entity by ID
   */
  async updateById(id: string, entityData: Partial<T>): Promise<UpdateResult> {
    this.logger.debug(`Updating entity with ID: ${id}`);
    const result = await this.update(id, entityData as any);
    this.logger.log(`Entity updated. Affected rows: ${result.affected}`);
    return result;
  }

  /**
   * Update entity by ID and return updated entity
   */
  async updateByIdAndReturn(
    id: string,
    entityData: Partial<T>,
  ): Promise<T | null> {
    await this.update(id, entityData as any);
    return this.findById(id);
  }

  /**
   * Upsert entity (insert or update) - checks by ID
   */
  async upsertById(
    entityData: DeepPartial<T>,
    options?: SaveOptions,
  ): Promise<T> {
    if (entityData.id) {
      const existing = await this.findById(entityData.id);
      if (existing) {
        return this.save({ ...existing, ...entityData }, options);
      }
    }
    return this.createEntity(entityData, options);
  }

  /**
   * Soft remove entity by ID
   */
  async softRemoveById(id: string): Promise<void> {
    this.logger.debug(`Soft removing entity with ID: ${id}`);
    const entity = await this.findById(id);
    if (entity) {
      await this.softRemove(entity);
      this.logger.log(`Entity soft removed with ID: ${id}`);
    } else {
      this.logger.warn(`Entity not found for soft remove. ID: ${id}`);
    }
  }

  /**
   * Restore soft-deleted entity
   */
  async restoreEntity(id: string): Promise<void> {
    const entity = await this.findOne({
      where: { id } as FindOptionsWhere<T>,
      withDeleted: true,
    });
    if (entity) {
      await this.recover(entity);
    }
  }

  /**
   * Hard delete entity by ID
   */
  async hardDelete(id: string): Promise<DeleteResult> {
    this.logger.debug(`Hard deleting entity with ID: ${id}`);
    const result = await this.delete(id);
    this.logger.log(`Entity hard deleted. Affected rows: ${result.affected}`);
    return result;
  }

  /**
   * Check if entity exists by ID
   */
  async existsById(id: string): Promise<boolean> {
    const count = await this.count({
      where: { id } as FindOptionsWhere<T>,
      withDeleted: false,
    });
    return count > 0;
  }

  /**
   * Count all entities (excluding soft-deleted)
   */
  async countAll(options?: FindManyOptions<T>): Promise<number> {
    return this.count({
      ...options,
      withDeleted: false,
    });
  }

  /**
   * Find one by criteria
   */
  async findOneBy(
    criteria: FindOptionsWhere<T> | FindOptionsWhere<T>[],
    options?: FindOneOptions<T>,
  ): Promise<T | null> {
    return this.findOne({
      where: criteria,
      ...options,
    });
  }

  /**
   * Find one by criteria or throw error
   */
  async findOneByOrFail(
    criteria: FindOptionsWhere<T> | FindOptionsWhere<T>[],
    options?: FindOneOptions<T>,
  ): Promise<T> {
    return this.findOneOrFail({
      where: criteria,
      ...options,
    });
  }

  /**
   * Find many by criteria
   *
   * Backwards compatible: Existing records with deletedAt = NULL are included.
   * Only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
   */
  async findManyBy(
    criteria: FindOptionsWhere<T> | FindOptionsWhere<T>[],
    options?: FindManyOptions<T>,
  ): Promise<T[]> {
    return this.find({
      where: criteria,
      ...options,
      withDeleted: false, // Explicitly exclude soft-deleted entities (deletedAt IS NOT NULL)
      // Note: Records with deletedAt = NULL (existing data) are included by default
    });
  }

  /**
   * Update many by criteria
   */
  async updateMany(
    criteria: FindOptionsWhere<T> | FindOptionsWhere<T>[],
    entityData: Partial<T>,
  ): Promise<UpdateResult> {
    return this.update(criteria, entityData as any);
  }

  /**
   * Delete many by criteria
   */
  async deleteMany(
    criteria: FindOptionsWhere<T> | FindOptionsWhere<T>[],
  ): Promise<DeleteResult> {
    return this.delete(criteria);
  }
}
