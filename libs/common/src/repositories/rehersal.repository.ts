/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */
import { Injectable } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { Rehersal } from '../entities/rehersal.entity';
import { User } from '../entities/user.entity';
import { RehearsalPartnerType } from '../enums/rehearsal.enum';
import { BaseRepository } from './base.repository';

export interface RehearsalPaginationOptions {
  page?: number;
  limit?: number;
  search?: string;
  partnerType?: RehearsalPartnerType;
  sortBy?: 'createdAt' | 'updatedAt';
  sortOrder?: 'ASC' | 'DESC';
}

/** Full filter options for listing rehearsals by user (admin, reports, etc.) */
export interface RehearsalListByUserOptions {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  partnerType?: RehearsalPartnerType;
  projectId?: string;
  sceneId?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy?:
    | 'createdAt'
    | 'updatedAt'
    | 'startedAt'
    | 'endedAt'
    | 'sessionDurationSeconds';
  sortOrder?: 'ASC' | 'DESC';
}

@Injectable()
export class RehersalRepository extends BaseRepository<Rehersal> {
  constructor(dataSource: DataSource) {
    super(Rehersal, dataSource.manager);
  }

  // find rehearsals by script ID
  // backwards compatible: existing records with deletedAt = NULL are included.
  // only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
  async findByScriptId(scriptId: string): Promise<Rehersal[]> {
    return this.findManyBy({ scriptId } as any, {
      order: { createdAt: 'DESC' },
      withDeleted: false, // explicitly exclude soft-deleted rehearsals
    });
  }

  // find rehearsals by user ID
  // backwards compatible: existing records with deletedAt = NULL are included.
  // only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
  async findByUserId(userId: string): Promise<Rehersal[]> {
    return this.findManyBy({ userId } as any, {
      order: { createdAt: 'DESC' },
      withDeleted: false, // explicitly exclude soft-deleted rehearsals
    });
  }

  // find rehearsals by project ID
  // backwards compatible: existing records with deletedAt = NULL are included.
  // only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
  async findByProjectId(projectId: string): Promise<Rehersal[]> {
    return this.findManyBy({ projectId } as any, {
      order: { createdAt: 'DESC' },
      withDeleted: false, // explicitly exclude soft-deleted rehearsals
    });
  }

  // find rehearsals by scene ID
  // backwards compatible: existing records with deletedAt = NULL are included.
  // only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
  async findBySceneId(sceneId: string): Promise<Rehersal[]> {
    return this.findManyBy({ sceneId } as any, {
      order: { createdAt: 'DESC' },
      withDeleted: false, // explicitly exclude soft-deleted rehearsals
    });
  }

  async findByBookingId(bookingId: string): Promise<Rehersal | null> {
    return this.findOneBy({ bookingId } as any, {
      withDeleted: false,
    });
  }

  // count rehearsals by script ID
  // backwards compatible: existing records with deletedAt = NULL are included.
  // only records with deletedAt IS NOT NULL (soft-deleted) are excluded.
  async countByScriptId(scriptId: string): Promise<number> {
    return this.countAll({
      where: { scriptId } as any,
      withDeleted: false, // explicitly exclude soft-deleted rehearsals
    });
  }

  // find rehearsals by user ID with pagination, search, sort, and filter
  // backwards compatible: existing records with deletedAt = NULL are included.
  async findByUserIdWithPagination(
    userId: string,
    options: RehearsalPaginationOptions = {},
  ): Promise<{ data: Rehersal[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      partnerType,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('rehearsal')
      .where('rehearsal.userId = :userId', { userId })
      .andWhere('rehearsal.deletedAt IS NULL') // exclude soft-deleted rehearsals
      .leftJoinAndSelect('rehearsal.project', 'project')
      .leftJoinAndSelect('rehearsal.script', 'script')
      .leftJoinAndSelect('rehearsal.scene', 'scene')
      // note: user data should be fetched via API composition from auth service
      .orderBy(`rehearsal.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (partnerType) {
      queryBuilder.andWhere('rehearsal.rehearsalPartnerType = :partnerType', {
        partnerType,
      });
    }

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where(
            'LOWER(rehearsal.rehearsalPartnerAiName) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          ).orWhere(
            'LOWER(rehearsal.rehearsalPartnerAiDescription) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          );
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

  // find rehearsals by project ID with pagination, search, sort, and filter
  // backwards compatible: existing records with deletedAt = NULL are included.
  async findByProjectIdWithPagination(
    projectId: string,
    options: RehearsalPaginationOptions = {},
  ): Promise<{ data: Rehersal[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      partnerType,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('rehearsal')
      .where('rehearsal.projectId = :projectId', { projectId })
      .andWhere('rehearsal.deletedAt IS NULL') // exclude soft-deleted rehearsals
      .leftJoinAndSelect('rehearsal.script', 'script')
      .leftJoinAndSelect('rehearsal.scene', 'scene')
      // note: user data should be fetched via API composition from auth service
      .orderBy(`rehearsal.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (partnerType) {
      queryBuilder.andWhere('rehearsal.rehearsalPartnerType = :partnerType', {
        partnerType,
      });
    }

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where(
            'LOWER(rehearsal.rehearsalPartnerAiName) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          ).orWhere(
            'LOWER(rehearsal.rehearsalPartnerAiDescription) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          );
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

  // find rehearsals by script ID with pagination, search, sort, and filter
  // backwards compatible: existing records with deletedAt = NULL are included.
  async findByScriptIdWithPagination(
    scriptId: string,
    options: RehearsalPaginationOptions = {},
  ): Promise<{ data: Rehersal[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      partnerType,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('rehearsal')
      .where('rehearsal.scriptId = :scriptId', { scriptId })
      .andWhere('rehearsal.deletedAt IS NULL') // exclude soft-deleted rehearsals
      .leftJoinAndSelect('rehearsal.project', 'project')
      .leftJoinAndSelect('rehearsal.scene', 'scene')
      // note: user data should be fetched via API composition from auth service
      .orderBy(`rehearsal.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (partnerType) {
      queryBuilder.andWhere('rehearsal.rehearsalPartnerType = :partnerType', {
        partnerType,
      });
    }

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where(
            'LOWER(rehearsal.rehearsalPartnerAiName) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          ).orWhere(
            'LOWER(rehearsal.rehearsalPartnerAiDescription) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          );
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

  // find rehearsals by scene ID with pagination, search, sort, and filter
  // backwards compatible: existing records with deletedAt = NULL are included.
  async findBySceneIdWithPagination(
    sceneId: string,
    options: RehearsalPaginationOptions = {},
  ): Promise<{ data: Rehersal[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      partnerType,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('rehearsal')
      .where('rehearsal.sceneId = :sceneId', { sceneId })
      .andWhere('rehearsal.deletedAt IS NULL') // exclude soft-deleted rehearsals
      .leftJoinAndSelect('rehearsal.project', 'project')
      .leftJoinAndSelect('rehearsal.script', 'script')
      // note: user data should be fetched via API composition from auth service
      .orderBy(`rehearsal.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (partnerType) {
      queryBuilder.andWhere('rehearsal.rehearsalPartnerType = :partnerType', {
        partnerType,
      });
    }

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where(
            'LOWER(rehearsal.rehearsalPartnerAiName) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          ).orWhere(
            'LOWER(rehearsal.rehearsalPartnerAiDescription) LIKE LOWER(:search)',
            {
              search: `%${search}%`,
            },
          );
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

  // soft delete rehearsal by ID
  async deleteRehearsal(id: string): Promise<void> {
    await this.softRemoveById(id);
  }

  /**
   * Shallow-merge a partial object into the `metaData` JSONB column without
   * reading-then-writing (avoids a lost-update race). Top-level keys in
   * `patch` overwrite; everything else is preserved. Parameterized — safe
   * against injection. Used to persist the durable sequence snapshot and the
   * analytics cache.
   */
  async mergeMetaData(id: string, patch: Record<string, any>): Promise<void> {
    await this.createQueryBuilder()
      .update()
      .set({
        metaData: () => `COALESCE("metaData", '{}'::jsonb) || :patch::jsonb`,
      })
      .setParameter('patch', JSON.stringify(patch))
      .where('id = :id', { id })
      .execute();
  }

  /**
   * Find rehearsals by user ID with full pagination, search, filters, and sort.
   * Returns raw rows with joined project, script, scene, and partner user data.
   */
  async findListByUserId(
    userId: string,
    options: RehearsalListByUserOptions = {},
  ): Promise<{ rows: any[]; total: number }> {
    const {
      page = 1,
      limit = 20,
      search,
      status,
      partnerType,
      projectId,
      sceneId,
      createdFrom,
      createdTo,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const qb = this.createQueryBuilder('rehearsal')
      .leftJoin('rehearsal.project', 'project')
      .leftJoin('rehearsal.script', 'script')
      .leftJoin('rehearsal.scene', 'scene')
      .leftJoin(
        User,
        'partnerUser',
        'partnerUser.id = rehearsal.rehearsalPartnerUserId',
      )
      .where('rehearsal.userId = :userId', { userId })
      .andWhere('rehearsal.deletedAt IS NULL');

    if (search?.trim()) {
      const term = `%${search.trim()}%`;
      qb.andWhere(
        new Brackets((sub) => {
          sub
            .where(
              "LOWER(COALESCE(rehearsal.rehearsalPartnerAiName, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            )
            .orWhere(
              "LOWER(COALESCE(rehearsal.rehearsalPartnerAiDescription, '')) LIKE LOWER(:searchTerm)",
              { searchTerm: term },
            )
            .orWhere(
              "LOWER(COALESCE(project.title, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            )
            .orWhere(
              "LOWER(COALESCE(script.title, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            )
            .orWhere(
              "LOWER(COALESCE(scene.heading, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            )
            .orWhere(
              "LOWER(COALESCE(partnerUser.fullName, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            )
            .orWhere(
              "LOWER(COALESCE(partnerUser.email, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            );
        }),
      );
    }

    if (status) {
      qb.andWhere('rehearsal.status = :status', { status });
    }
    if (partnerType) {
      qb.andWhere('rehearsal.rehearsalPartnerType = :partnerType', {
        partnerType,
      });
    }
    if (projectId) {
      qb.andWhere('rehearsal.projectId = :projectId', { projectId });
    }
    if (sceneId) {
      qb.andWhere('rehearsal.sceneId = :sceneId', { sceneId });
    }
    if (createdFrom) {
      qb.andWhere('rehearsal.createdAt >= :createdFrom', {
        createdFrom: new Date(createdFrom),
      });
    }
    if (createdTo) {
      const end = new Date(createdTo);
      end.setHours(23, 59, 59, 999);
      qb.andWhere('rehearsal.createdAt <= :createdTo', { createdTo: end });
    }

    const sortColumn =
      sortBy === 'sessionDurationSeconds'
        ? 'rehearsal.sessionDurationSeconds'
        : `rehearsal.${sortBy}`;
    qb.orderBy(sortColumn, sortOrder, 'NULLS LAST');

    const total = await qb.getCount();
    const rows = await qb
      .select([
        'rehearsal.id AS "id"',
        'rehearsal.status AS "status"',
        'rehearsal.mode AS "mode"',
        'rehearsal.runtimeEngine AS "runtimeEngine"',
        'rehearsal.rehearsalPartnerType AS "rehearsalPartnerType"',
        'rehearsal.rehearsalPartnerUserId AS "rehearsalPartnerUserId"',
        'rehearsal.rehearsalPartnerAiName AS "rehearsalPartnerAiName"',
        'rehearsal.rehearsalPartnerAiDescription AS "rehearsalPartnerAiDescription"',
        'rehearsal.rehearsalPartnerAiImage AS "rehearsalPartnerAiImage"',
        'rehearsal.characterId AS "characterId"',
        'rehearsal.bookingId AS "bookingId"',
        'rehearsal.metaData AS "metaData"',
        'rehearsal.startedAt AS "startedAt"',
        'rehearsal.endedAt AS "endedAt"',
        'rehearsal.sessionDurationSeconds AS "sessionDurationSeconds"',
        'rehearsal.createdAt AS "createdAt"',
        'rehearsal.updatedAt AS "updatedAt"',
        'rehearsal.projectId AS "projectId"',
        'rehearsal.scriptId AS "scriptId"',
        'rehearsal.sceneId AS "sceneId"',
        'project.title AS "projectTitle"',
        'script.title AS "scriptTitle"',
        'scene.number AS "sceneNumber"',
        'scene.heading AS "sceneHeading"',
        'partnerUser.fullName AS "partnerUserName"',
        'partnerUser.email AS "partnerUserEmail"',
      ])
      .skip((page - 1) * limit)
      .take(limit)
      .getRawMany();

    return { rows, total };
  }
}
