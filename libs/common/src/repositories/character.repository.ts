/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { Injectable } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { Character } from '../entities/character.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class CharacterRepository extends BaseRepository<Character> {
  constructor(dataSource: DataSource) {
    super(Character, dataSource.manager);
  }

  // find character by ID
  async findById(id: string): Promise<Character | null> {
    return super.findById(id);
  }

  // find character by ID or throw error
  async findByIdOrFail(id: string): Promise<Character> {
    return super.findByIdOrFail(id);
  }

  // find characters by script ID
  async findByScriptId(scriptId: string): Promise<Character[]> {
    return this.findManyBy({ scriptId } as any, {
      order: { name: 'ASC' },
    });
  }

  // find characters by script ID with scenes loaded
  async findByScriptIdWithScenes(scriptId: string): Promise<Character[]> {
    return this.findManyBy({ scriptId } as any, {
      relations: ['scenes'],
      order: { name: 'ASC' },
    });
  }

  // find character by script ID and name (case-insensitive)
  async findByScriptIdAndName(
    scriptId: string,
    name: string,
  ): Promise<Character | null> {
    return this.createQueryBuilder('character')
      .where('character.scriptId = :scriptId', { scriptId })
      .andWhere('LOWER(character.name) = LOWER(:name)', { name })
      .andWhere('character.deletedAt IS NULL')
      .getOne();
  }

  // find characters by name (across all scripts)
  async findByName(name: string): Promise<Character[]> {
    return this.findManyBy({ name } as any);
  }

  // create a new character
  async createCharacter(characterData: Partial<Character>): Promise<Character> {
    return this.createEntity(characterData);
  }

  // create multiple characters
  async createCharacters(
    charactersData: Partial<Character>[],
  ): Promise<Character[]> {
    return this.createMany(charactersData);
  }

  // update character
  async updateCharacter(
    id: string,
    characterData: Partial<Character>,
  ): Promise<Character | null> {
    return this.updateByIdAndReturn(id, characterData);
  }

  /**
   * Soft delete character by ID
   */
  async deleteCharacter(id: string): Promise<void> {
    await this.softRemoveById(id);
  }

  // soft delete all characters for a script
  async deleteByScriptId(scriptId: string): Promise<void> {
    const characters = await this.findManyBy({ scriptId } as any);
    if (characters.length > 0) {
      await this.softRemove(characters);
    }
  }

  // count characters by script ID
  async countByScriptId(scriptId: string): Promise<number> {
    return this.countAll({ where: { scriptId } as any });
  }

  // find characters by script ID with pagination, search, sort, and filter
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
    data: Character[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'name',
      sortOrder = 'ASC',
    } = options;

    const queryBuilder = this.createQueryBuilder('character')
      .where('character.scriptId = :scriptId', { scriptId })
      .andWhere('character.deletedAt IS NULL') // exclude soft-deleted characters (backwards compatible: includes existing records with deletedAt = NULL)
      .orderBy(`character.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(character.name) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(character.description) LIKE LOWER(:search)', {
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
