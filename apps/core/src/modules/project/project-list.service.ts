/**
 * ProjectListService
 *
 * Lists a user's projects with full details: scenes, recordings, rehearsals counts,
 * and default character name. Supports search, pagination, filters, and sorting.
 */
import {
  Project,
  ProjectAnalysisState,
  ProjectStatus,
  Script,
  User,
} from '@app/common';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import {
  ListProjectsByUserIdQueryDto,
  ProjectListSortBy,
} from './dto/list-projects-by-user-query.dto';
import {
  buildProjectAnalysisSummary,
  ProjectScriptStatusCounts,
} from './project-analysis-summary.util';

const SCENES_SUB = `(SELECT COALESCE(SUM(cnt), 0)::int FROM (
  SELECT COUNT(*)::int AS cnt FROM core_schema.scenes sc
  INNER JOIN core_schema.scripts s ON s.id = sc."scriptId" AND s."deletedAt" IS NULL
  WHERE s."projectId" = project.id AND sc."deletedAt" IS NULL
) x)`;
const RECORDINGS_SUB = `(SELECT COUNT(*)::int FROM studio_schema.recordings r WHERE r."projectId" = project.id AND r."deletedAt" IS NULL)`;
const REHEARSALS_SUB = `(SELECT COUNT(*)::int FROM studio_schema.rehersals rh WHERE rh."projectId" = project.id AND rh."deletedAt" IS NULL)`;
const DEFAULT_CHAR_SUB = `(SELECT c.name FROM core_schema.scripts s
  LEFT JOIN core_schema.characters c ON c.id = s."defaultCharacterId" AND c."deletedAt" IS NULL
  WHERE s."projectId" = project.id AND s."deletedAt" IS NULL
  ORDER BY s."createdAt" ASC LIMIT 1)`;

export interface ProjectListItem {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  isFlagged: boolean;
  defaultCharacterName: string | null;
  scenesCount: number;
  recordingsCount: number;
  rehearsalsCount: number;
  analysisState: ProjectAnalysisState;
  attentionRequired: boolean;
  totalScripts: number;
  uploadedScripts: number;
  processingScripts: number;
  analyzedScripts: number;
  failedScripts: number;
  degradedScripts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectListResult {
  data: ProjectListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

@Injectable()
export class ProjectListService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * List projects for a user. We ensure the user exists, then fetch projects
   * with aggregated counts and default character name, applying filters and sort.
   */
  async listByUserId(
    userId: string,
    query: ListProjectsByUserIdQueryDto,
  ): Promise<any> {
    await this.ensureUserExists(userId);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;

    const baseQb = this.dataSource
      .getRepository(Project)
      .createQueryBuilder('project')
      .where('project.userId = :userId', { userId })
      .andWhere('project.deletedAt IS NULL')
      .select([
        'project.id AS "id"',
        'project.userId AS "userId"',
        'project.title AS "title"',
        'project.description AS "description"',
        'project.status AS "status"',
        'project.isFlagged AS "isFlagged"',
        'project.createdAt AS "createdAt"',
        'project.updatedAt AS "updatedAt"',
      ])
      .addSelect(DEFAULT_CHAR_SUB, 'defaultCharacterName')
      .addSelect(SCENES_SUB, 'scenesCount')
      .addSelect(RECORDINGS_SUB, 'recordingsCount')
      .addSelect(REHEARSALS_SUB, 'rehearsalsCount');

    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      baseQb.andWhere(
        new Brackets((sub) => {
          sub
            .where(
              "LOWER(COALESCE(project.title, '')) LIKE LOWER(:searchTerm)",
              {
                searchTerm: term,
              },
            )
            .orWhere(
              "LOWER(COALESCE(project.description, '')) LIKE LOWER(:searchTerm)",
              { searchTerm: term },
            )
            .orWhere(
              `LOWER(COALESCE(${DEFAULT_CHAR_SUB}, \'\')) LIKE LOWER(:searchTerm)`,
              { searchTerm: term },
            );
        }),
      );
    }

    if (query.status) {
      baseQb.andWhere('project.status = :status', { status: query.status });
    }

    if (query.scenesMin != null) {
      baseQb.andWhere(`${SCENES_SUB} >= :scenesMin`, {
        scenesMin: query.scenesMin,
      });
    }
    if (query.scenesMax != null) {
      baseQb.andWhere(`${SCENES_SUB} <= :scenesMax`, {
        scenesMax: query.scenesMax,
      });
    }
    if (query.recordingsMin != null) {
      baseQb.andWhere(`${RECORDINGS_SUB} >= :recordingsMin`, {
        recordingsMin: query.recordingsMin,
      });
    }
    if (query.recordingsMax != null) {
      baseQb.andWhere(`${RECORDINGS_SUB} <= :recordingsMax`, {
        recordingsMax: query.recordingsMax,
      });
    }
    if (query.rehearsalsMin != null) {
      baseQb.andWhere(`${REHEARSALS_SUB} >= :rehearsalsMin`, {
        rehearsalsMin: query.rehearsalsMin,
      });
    }
    if (query.rehearsalsMax != null) {
      baseQb.andWhere(`${REHEARSALS_SUB} <= :rehearsalsMax`, {
        rehearsalsMax: query.rehearsalsMax,
      });
    }

    const sortColumn = this.getSortColumn(query.sortBy);
    baseQb.orderBy(sortColumn, query.sortOrder ?? 'DESC', 'NULLS LAST');

    const total = await baseQb.getCount();

    const rows = await baseQb.offset(offset).limit(limit).getRawMany<{
      id: string;
      userId: string;
      title: string;
      description: string | null;
      status: ProjectStatus;
      isFlagged: boolean;
      defaultCharacterName: string | null;
      scenesCount: string;
      recordingsCount: string;
      rehearsalsCount: string;
      createdAt: Date;
      updatedAt: Date;
    }>();

    const projectIds = rows.map((row) => row.id);
    const scriptCountsByProjectId =
      await this.getScriptCountsByProjectId(projectIds);

    const data = rows.map((row) => {
      const summary = buildProjectAnalysisSummary(
        scriptCountsByProjectId.get(row.id) ?? {
          totalScripts: 0,
          uploadedScripts: 0,
          processingScripts: 0,
          analyzedScripts: 0,
          failedScripts: 0,
          degradedScripts: 0,
        },
      );

      return {
        id: row.id,
        userId: row.userId,
        title: row.title,
        description: row.description ?? null,
        status: row.status,
        isFlagged: row.isFlagged ?? false,
        defaultCharacterName: row.defaultCharacterName ?? null,
        scenesCount: parseInt(row.scenesCount ?? '0', 10),
        recordingsCount: parseInt(row.recordingsCount ?? '0', 10),
        rehearsalsCount: parseInt(row.rehearsalsCount ?? '0', 10),
        ...summary,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      };
    });

    const totalPages = Math.ceil(total / limit) || 1;

    return {
      success: true,
      message: 'Projects retrieved successfully',
      data: {
        items: data,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const user = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .where('user.id = :userId', { userId })
      .getOne();
    if (!user) {
      throw new NotFoundException('User not found');
    }
  }

  private getSortColumn(sortBy?: ProjectListSortBy): string {
    switch (sortBy) {
      case ProjectListSortBy.TITLE:
        return 'project.title';
      case ProjectListSortBy.UPDATED_AT:
        return 'project.updatedAt';
      case ProjectListSortBy.SCENES_COUNT:
        return SCENES_SUB;
      case ProjectListSortBy.RECORDINGS_COUNT:
        return RECORDINGS_SUB;
      case ProjectListSortBy.REHEARSALS_COUNT:
        return REHEARSALS_SUB;
      default:
        return 'project.createdAt';
    }
  }

  private async getScriptCountsByProjectId(
    projectIds: string[],
  ): Promise<Map<string, ProjectScriptStatusCounts>> {
    if (projectIds.length === 0) {
      return new Map();
    }

    const rows = await this.dataSource
      .getRepository(Script)
      .createQueryBuilder('script')
      .select('script.projectId', 'projectId')
      .addSelect('COUNT(*)', 'totalScripts')
      .addSelect(
        `SUM(CASE WHEN script.status = 'UPLOADED' THEN 1 ELSE 0 END)`,
        'uploadedScripts',
      )
      .addSelect(
        `SUM(CASE WHEN script.status = 'PROCESSING' THEN 1 ELSE 0 END)`,
        'processingScripts',
      )
      .addSelect(
        `SUM(CASE WHEN script.status = 'ANALYZED' THEN 1 ELSE 0 END)`,
        'analyzedScripts',
      )
      .addSelect(
        `SUM(CASE WHEN script.status = 'FAILED' THEN 1 ELSE 0 END)`,
        'failedScripts',
      )
      .where('script.projectId IN (:...projectIds)', { projectIds })
      .andWhere('script.deletedAt IS NULL')
      .groupBy('script.projectId')
      .getRawMany<{
        projectId: string;
        totalScripts: string;
        uploadedScripts: string;
        processingScripts: string;
        analyzedScripts: string;
        failedScripts: string;
      }>();

    return new Map(
      rows.map((row) => [
        row.projectId,
        {
          totalScripts: parseInt(row.totalScripts ?? '0', 10),
          uploadedScripts: parseInt(row.uploadedScripts ?? '0', 10),
          processingScripts: parseInt(row.processingScripts ?? '0', 10),
          analyzedScripts: parseInt(row.analyzedScripts ?? '0', 10),
          failedScripts: parseInt(row.failedScripts ?? '0', 10),
          degradedScripts: 0,
        },
      ]),
    );
  }
}
