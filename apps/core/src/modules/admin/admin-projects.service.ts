import {
  Project,
  ProjectAnalysisState,
  ProjectFlagStatus,
  ProjectFlagged,
  ProjectStatus,
  Script,
  User,
} from '@app/common';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import {
  AdminProjectSortBy,
  AdminProjectTabFilter,
  ListProjectsQueryDto,
} from './dto/list-projects-query.dto';
import {
  buildProjectAnalysisSummary,
  ProjectScriptStatusCounts,
} from '../project/project-analysis-summary.util';
import {
  ADMIN_PROJECT_ALIAS,
  ADMIN_PROJECT_OWNER_ALIAS,
} from './admin-query-aliases';

export interface AdminProjectListItem {
  id: string;
  name: string;
  uploadedDate: Date;
  isFlagged: boolean;
  flagStatus: 'flagged' | 'not_flagged';
  createdBy: {
    id: string;
    fullName: string | null;
    email: string | null;
    avatar: string | null;
  };
  latestFlag: {
    id: string;
    status: ProjectFlagStatus;
    reason: string | null;
    flaggedAt: Date;
    flaggedBy: {
      userId: string | null;
      name: string | null;
      email: string | null;
    };
  } | null;
}

export interface PaginatedAdminProjectsResult {
  data: AdminProjectListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface AdminProjectEnrichedListItem extends AdminProjectListItem {
  status: ProjectStatus;
  analysisState: ProjectAnalysisState;
  attentionRequired: boolean;
  totalScripts: number;
  failedScripts: number;
}

export interface PaginatedAdminProjectsEnrichedResult {
  data: AdminProjectEnrichedListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

@Injectable()
export class AdminProjectsService {
  constructor(private readonly dataSource: DataSource) {}

  async listProjects(
    query: ListProjectsQueryDto,
  ): Promise<PaginatedAdminProjectsResult> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;

    const p = ADMIN_PROJECT_ALIAS;
    const own = ADMIN_PROJECT_OWNER_ALIAS;
    const lf = 'lf';

    const latestFlagJoin = `
      ${lf}."projectId" = ${p}.id
      AND ${lf}."deletedAt" IS NULL
      AND ${lf}."isActive" = true
      AND ${lf}."createdAt" = (
        SELECT MAX(pf2."createdAt")
        FROM core_schema.project_flagged pf2
        WHERE pf2."projectId" = ${p}.id
          AND pf2."deletedAt" IS NULL
          AND pf2."isActive" = true
      )
    `;

    const qb = this.dataSource
      .getRepository(Project)
      .createQueryBuilder(p)
      .leftJoin(User, own, `${own}.id = ${p}."userId"::uuid`)
      .leftJoin(ProjectFlagged, lf, latestFlagJoin)
      .where(`${p}."deletedAt" IS NULL`);

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        new Brackets((subQb) => {
          subQb
            .where(`LOWER(COALESCE(${p}.title, '')) LIKE :term`, { term })
            .orWhere(`LOWER(COALESCE(${own}.fullName, '')) LIKE :term`, {
              term,
            })
            .orWhere(`LOWER(COALESCE(${own}.email, '')) LIKE :term`, { term });
        }),
      );
    }

    if (query.tab === AdminProjectTabFilter.FLAGGED) {
      qb.andWhere(`${p}."isFlagged" = true`);
    } else if (query.tab === AdminProjectTabFilter.REVIEWED) {
      qb.andWhere(`${lf}.status = :reviewedFlagStatus`, {
        reviewedFlagStatus: ProjectFlagStatus.REVIEWED,
      });
    }

    if (query.sortBy === AdminProjectSortBy.NAME) {
      qb.orderBy(`${p}.title`, query.sortOrder);
    } else if (query.sortBy === AdminProjectSortBy.CREATED_BY) {
      qb.orderBy(`${own}.fullName`, query.sortOrder, 'NULLS LAST');
    } else if (query.sortBy === AdminProjectSortBy.FLAGGED_AT) {
      qb.orderBy(`${lf}."createdAt"`, query.sortOrder, 'NULLS LAST');
    } else {
      qb.orderBy(`${p}."createdAt"`, query.sortOrder);
    }

    const total = await qb.clone().getCount();
    const rows = await qb
      .select([
        `${p}.id AS "id"`,
        `${p}.title AS "name"`,
        `${p}."createdAt" AS "uploadedDate"`,
        `${p}."isFlagged" AS "isFlagged"`,
        `${own}.id AS "createdById"`,
        `${own}.fullName AS "createdByFullName"`,
        `${own}.email AS "createdByEmail"`,
        `${own}.avatar AS "createdByAvatar"`,
        `${lf}.id AS "latestFlagId"`,
        `${lf}.reason AS "latestFlagReason"`,
        `${lf}.status AS "latestFlagStatus"`,
        `${lf}."createdAt" AS "latestFlagCreatedAt"`,
        `${lf}."flaggedByUserId" AS "latestFlaggedByUserId"`,
        `${lf}."flaggedByName" AS "latestFlaggedByName"`,
        `${lf}."flaggedByEmail" AS "latestFlaggedByEmail"`,
      ])
      .offset(offset)
      .limit(limit)
      .getRawMany<{
        id: string;
        name: string;
        uploadedDate: Date;
        isFlagged: boolean;
        createdById: string;
        createdByFullName: string | null;
        createdByEmail: string | null;
        createdByAvatar: string | null;
        latestFlagId: string | null;
        latestFlagReason: string | null;
        latestFlagStatus: ProjectFlagStatus | null;
        latestFlagCreatedAt: Date | null;
        latestFlaggedByUserId: string | null;
        latestFlaggedByName: string | null;
        latestFlaggedByEmail: string | null;
      }>();

    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        uploadedDate: new Date(row.uploadedDate),
        isFlagged: row.isFlagged,
        flagStatus: row.isFlagged ? 'flagged' : 'not_flagged',
        createdBy: {
          id: row.createdById,
          fullName: row.createdByFullName ?? null,
          email: row.createdByEmail ?? null,
          avatar: row.createdByAvatar ?? null,
        },
        latestFlag: row.latestFlagId
          ? {
              id: row.latestFlagId,
              status: row.latestFlagStatus ?? ProjectFlagStatus.PENDING,
              reason: row.latestFlagReason ?? null,
              flaggedAt: row.latestFlagCreatedAt
                ? new Date(row.latestFlagCreatedAt)
                : new Date(row.uploadedDate),
              flaggedBy: {
                userId: row.latestFlaggedByUserId ?? null,
                name: row.latestFlaggedByName ?? null,
                email: row.latestFlaggedByEmail ?? null,
              },
            }
          : null,
      })),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  async listProjectsEnriched(
    query: ListProjectsQueryDto,
  ): Promise<PaginatedAdminProjectsEnrichedResult> {
    const base = await this.listProjects(query);
    const projectIds = base.data.map((item) => item.id);
    const scriptCountsByProjectId =
      await this.getScriptCountsByProjectId(projectIds);

    return {
      ...base,
      data: base.data.map((item) => {
        const row = scriptCountsByProjectId.get(item.id);
        const scriptCounts: ProjectScriptStatusCounts = row ?? {
          totalScripts: 0,
          uploadedScripts: 0,
          processingScripts: 0,
          analyzedScripts: 0,
          failedScripts: 0,
          degradedScripts: 0,
        };
        const summary = buildProjectAnalysisSummary(scriptCounts);
        return {
          ...item,
          status: row?.projectStatus ?? ProjectStatus.DRAFT,
          ...summary,
        };
      }),
    };
  }

  private async getScriptCountsByProjectId(
    projectIds: string[],
  ): Promise<
    Map<string, ProjectScriptStatusCounts & { projectStatus: ProjectStatus }>
  > {
    if (projectIds.length === 0) {
      return new Map();
    }

    const p = ADMIN_PROJECT_ALIAS;
    const projects = await this.dataSource
      .getRepository(Project)
      .createQueryBuilder(p)
      .select([`${p}.id AS "id"`, `${p}.status AS "status"`])
      .where(`${p}.id IN (:...projectIds)`, { projectIds })
      .getRawMany<{ id: string; status: ProjectStatus }>();
    const statusById = new Map(projects.map((row) => [row.id, row.status]));

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
        `SUM(CASE WHEN script.status IN ('PROCESSING', 'PARSING', 'ANALYZING') THEN 1 ELSE 0 END)`,
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
      projectIds.map((projectId) => {
        const row = rows.find((r) => r.projectId === projectId);
        return [
          projectId,
          {
            totalScripts: parseInt(row?.totalScripts ?? '0', 10),
            uploadedScripts: parseInt(row?.uploadedScripts ?? '0', 10),
            processingScripts: parseInt(row?.processingScripts ?? '0', 10),
            analyzedScripts: parseInt(row?.analyzedScripts ?? '0', 10),
            failedScripts: parseInt(row?.failedScripts ?? '0', 10),
            degradedScripts: 0,
            projectStatus: statusById.get(projectId) ?? ProjectStatus.DRAFT,
          },
        ];
      }),
    );
  }

  async flagProject(
    projectId: string,
    flaggedByUserId: string | undefined,
    reason?: string,
  ): Promise<{
    message: string;
    projectId: string;
    isFlagged: boolean;
    latestFlag: {
      id: string;
      status: ProjectFlagStatus;
      reason: string | null;
      flaggedAt: string;
      flaggedBy: {
        userId: string | null;
        name: string | null;
        email: string | null;
      };
    };
  }> {
    const projectRepo = this.dataSource.getRepository(Project);
    const flagRepo = this.dataSource.getRepository(ProjectFlagged);
    const userRepo = this.dataSource.getRepository(User);

    const project = await projectRepo.findOne({ where: { id: projectId } });
    if (!project || project.deletedAt) {
      throw new NotFoundException('Project not found');
    }

    const adminUser = flaggedByUserId
      ? await userRepo.findOne({ where: { id: flaggedByUserId } })
      : null;

    const normalizedReason = reason?.trim() ? reason.trim() : null;
    const savedFlag = await flagRepo.save(
      flagRepo.create({
        projectId: project.id,
        flaggedByUserId: adminUser?.id ?? flaggedByUserId ?? null,
        flaggedByName: adminUser?.fullName ?? null,
        flaggedByEmail: adminUser?.email ?? null,
        reason: normalizedReason,
        status: ProjectFlagStatus.PENDING,
        isActive: true,
      }),
    );

    if (!project.isFlagged) {
      project.isFlagged = true;
      await projectRepo.save(project);
    }

    return {
      message: 'Project flagged successfully',
      projectId: project.id,
      isFlagged: true,
      latestFlag: {
        id: savedFlag.id,
        status: savedFlag.status,
        reason: savedFlag.reason ?? null,
        flaggedAt: savedFlag.createdAt.toISOString(),
        flaggedBy: {
          userId: savedFlag.flaggedByUserId ?? null,
          name: savedFlag.flaggedByName ?? null,
          email: savedFlag.flaggedByEmail ?? null,
        },
      },
    };
  }
}
