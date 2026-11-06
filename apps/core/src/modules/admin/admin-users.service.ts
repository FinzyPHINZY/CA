import {
  Recording,
  RecordingStatus,
  RecordingTypeEnum,
  RehearsalPartnerType,
  RehearsalStatus,
  Rehersal,
  User,
} from '@app/common';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { RehearsalListService } from '../rehearsal/rehearsal-list.service';
import {
  ListUserRecordingsQueryDto,
  ListUserRehearsalsQueryDto,
  ListUsersQueryDto,
  UserRecordingSortBy,
  UserRehearsalSortBy,
  UserListSortBy,
  UserListSortOrder,
} from './dto/list-users-query.dto';
import {
  ADMIN_BILLING_SUB_ALIAS,
  ADMIN_PROJECT_ALIAS,
  ADMIN_RECORDING_ALIAS,
  ADMIN_REHEARSAL_ALIAS,
  ADMIN_USER_ALIAS,
  ADMIN_USER_ROLE_ALIAS,
} from './admin-query-aliases';

const ACTOR_READER_ROLES = ['actor', 'reader'];

export interface UserManagementListItem {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  accountType: string;
  createdAt: Date;
  userStatus: string;
  subscriptionStatus: string;
  deactivationReason?: string | null;
  deactivatedAt?: Date | null;
  reactivationReason?: string | null;
  reactivatedAt?: Date | null;
  banReason?: string | null;
  bannedAt?: Date | null;
}

export interface PaginatedUserManagementResult {
  data: UserManagementListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface AdminUserSubscriptionDetails {
  id: string;
  plan: string;
  status: string;
  expiresAt: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface AdminSingleUserResult {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
  accountType: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  disabled: boolean;
  userStatus: string;
  subscriptionStatus: string;
  deactivationReason?: string | null;
  deactivatedAt?: Date | null;
  reactivationReason?: string | null;
  reactivatedAt?: Date | null;
  banReason?: string | null;
  bannedAt?: Date | null;
  recordingsCount: number;
  rehearsalsCount: number;
  subscription: AdminUserSubscriptionDetails | null;
}

export interface AdminUserRecordingListItem {
  id: string;
  titleCard: string | null;
  summary: string | null;
  status: RecordingStatus;
  type: RecordingTypeEnum;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  projectTitle: string | null;
  scriptId: string;
  scriptTitle: string | null;
  sceneId: string;
  sceneNumber: number | null;
  sceneHeading: string | null;
}

export interface AdminUserRehearsalListItem {
  id: string;
  status: RehearsalStatus;
  rehearsalPartnerType: RehearsalPartnerType;
  rehearsalPartnerUserId: string | null;
  rehearsalPartnerAiName: string | null;
  partnerDisplayName: string | null;
  partner: {
    partnerType: RehearsalPartnerType;
    userId: string | null;
    userName: string | null;
    userEmail: string | null;
    aiName: string | null;
    aiImage: string | null;
  };
  startedAt: Date | null;
  endedAt: Date | null;
  sessionDurationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
  projectId: string;
  projectTitle: string | null;
  scriptId: string;
  scriptTitle: string | null;
  sceneId: string;
  sceneNumber: number | null;
  sceneHeading: string | null;
}

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);
  private subscriptionsTableAvailable: boolean | null = null;
  private userBanColumnsAvailable: boolean | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly rehearsalListService: RehearsalListService,
  ) {}

  private async hasSubscriptionsTable(): Promise<boolean> {
    if (this.subscriptionsTableAvailable !== null) {
      return this.subscriptionsTableAvailable;
    }

    try {
      const result = await this.dataSource.query(
        "SELECT to_regclass('billing_schema.subscriptions') IS NOT NULL AS exists",
      );
      const existsValue = result?.[0]?.exists;
      this.subscriptionsTableAvailable =
        existsValue === true || existsValue === 't' || existsValue === 1;
    } catch (error) {
      this.logger.warn(
        `Unable to verify billing_schema.subscriptions availability; falling back to no-subscription mode: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.subscriptionsTableAvailable = false;
    }
    return this.subscriptionsTableAvailable;
  }

  /** Ban columns come from migration 020; older DBs must not take a 500 on list/get user. */
  private async hasUserBanColumns(): Promise<boolean> {
    if (this.userBanColumnsAvailable !== null) {
      return this.userBanColumnsAvailable;
    }

    try {
      const rows = await this.dataSource.query<{ cnt: string }>(`
        SELECT COUNT(*)::text AS cnt
        FROM pg_catalog.pg_attribute a
        INNER JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
        INNER JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
        WHERE n.nspname = 'auth_schema'
          AND c.relname = 'users'
          AND a.attname IN ('banReason', 'bannedAt')
          AND NOT a.attisdropped
      `);
      const n = Number(rows?.[0]?.cnt ?? 0);
      this.userBanColumnsAvailable = n >= 2;
    } catch (error) {
      this.logger.warn(
        `Unable to verify auth_schema.users ban columns; omitting ban fields: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.userBanColumnsAvailable = false;
    }
    return this.userBanColumnsAvailable;
  }

  async listUsers(
    query: ListUsersQueryDto,
  ): Promise<PaginatedResult<UserManagementListItem>> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;
    const sortBy = query.sortBy ?? UserListSortBy.CREATED_AT;
    const sortOrder = query.sortOrder ?? UserListSortOrder.DESC;
    const hasSubscriptionsTable = await this.hasSubscriptionsTable();
    const hasBanColumns = await this.hasUserBanColumns();
    if (query.createdFrom && query.createdTo) {
      const createdFrom = new Date(query.createdFrom);
      const createdTo = new Date(query.createdTo);
      if (createdFrom > createdTo) {
        throw new BadRequestException(
          '"createdFrom" must be earlier than or equal to "createdTo"',
        );
      }
    }

    const userStatusExpr = `
      CASE
        WHEN ${ADMIN_USER_ALIAS}."deletedAt" IS NOT NULL THEN 'banned'
        WHEN ${ADMIN_USER_ALIAS}."disabled" = true THEN 'deactivated'
        WHEN ${ADMIN_USER_ALIAS}."lastLoginAt" IS NULL THEN 'inactive'
        ELSE 'active'
      END
    `;

    const bsub = ADMIN_BILLING_SUB_ALIAS;
    const subscriptionStatusExpr = hasSubscriptionsTable
      ? `
        CASE
          WHEN ${bsub}.status = 'ACTIVE' AND (${bsub}."expiresAt" IS NULL OR ${bsub}."expiresAt" >= NOW()) THEN 'subscribed'
          WHEN ${bsub}.status = 'ACTIVE' AND ${bsub}."expiresAt" < NOW() THEN 'past_due'
          WHEN ${bsub}.status = 'EXPIRED' THEN 'expired'
          WHEN ${bsub}.status = 'CANCELLED' THEN 'cancelled'
          WHEN ${bsub}.status IS NULL THEN 'inactive'
          ELSE LOWER(${bsub}.status::text)
        END
      `
      : `'inactive'`;

    const u = ADMIN_USER_ALIAS;
    const role = ADMIN_USER_ROLE_ALIAS;

    const qb = this.dataSource
      .getRepository(User)
      .createQueryBuilder(u)
      .withDeleted()
      .leftJoin(`${u}.role`, role)
      .select([
        `${u}.id AS "id"`,
        `${u}.fullName AS "name"`,
        `${u}.email AS "email"`,
        `${u}.avatar AS "avatar"`,
        `${role}.code AS "accountType"`,
        `${u}."createdAt" AS "createdAt"`,
        `${u}."deactivationReason" AS "deactivationReason"`,
        `${u}."deactivatedAt" AS "deactivatedAt"`,
        `${u}."reactivationReason" AS "reactivationReason"`,
        `${u}."reactivatedAt" AS "reactivatedAt"`,
        ...(hasBanColumns
          ? ([
              `${u}."banReason" AS "banReason"`,
              `${u}."bannedAt" AS "bannedAt"`,
            ] as const)
          : []),
      ])
      .addSelect(userStatusExpr, 'userStatus')
      .addSelect(subscriptionStatusExpr, 'subscriptionStatus')
      .where(`${role}.code IN (:...allowedRoles)`, {
        allowedRoles: ACTOR_READER_ROLES,
      });

    if (hasSubscriptionsTable) {
      qb.leftJoin(
        'billing_schema.subscriptions',
        bsub,
        `
          ${bsub}."userId" = ${u}.id
          AND ${bsub}."deletedAt" IS NULL
          AND ${bsub}."createdAt" = (
            SELECT MAX(s2."createdAt")
            FROM billing_schema.subscriptions s2
            WHERE s2."userId" = ${u}.id
              AND s2."deletedAt" IS NULL
          )
        `,
      );
    }

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        new Brackets((subQb) => {
          subQb
            .where(`LOWER(COALESCE(${u}.fullName, '')) LIKE :term`, { term })
            .orWhere(`LOWER(COALESCE(${u}.email, '')) LIKE :term`, { term });
        }),
      );
    }

    if (query.role) {
      qb.andWhere(`${role}.code = :role`, { role: query.role });
    }

    if (query.status) {
      qb.andWhere(`${userStatusExpr} = :status`, { status: query.status });
    }

    if (query.subscriptionStatus) {
      if (!hasSubscriptionsTable) {
        if (query.subscriptionStatus !== 'inactive') {
          return {
            data: [],
            total: 0,
            page,
            limit,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          };
        }
      } else {
        qb.andWhere(`${subscriptionStatusExpr} = :subscriptionStatus`, {
          subscriptionStatus: query.subscriptionStatus,
        });
      }
    }

    if (query.createdFrom) {
      qb.andWhere(`${u}."createdAt" >= :createdFrom`, {
        createdFrom: new Date(query.createdFrom),
      });
    }

    if (query.createdTo) {
      const end = new Date(query.createdTo);
      end.setHours(23, 59, 59, 999);
      qb.andWhere(`${u}."createdAt" <= :createdTo`, {
        createdTo: end,
      });
    }

    if (sortBy === UserListSortBy.NAME) {
      qb.orderBy(`${u}.fullName`, sortOrder);
    } else if (sortBy === UserListSortBy.EMAIL) {
      qb.orderBy(`${u}.email`, sortOrder);
    } else {
      qb.orderBy(`${u}."createdAt"`, sortOrder);
    }

    const total = await qb.clone().getCount();
    const rows = await qb
      .offset(offset)
      .limit(limit)
      .getRawMany<UserManagementListItem>();

    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
        deactivatedAt: row.deactivatedAt ? new Date(row.deactivatedAt) : null,
        reactivatedAt: row.reactivatedAt ? new Date(row.reactivatedAt) : null,
        banReason: hasBanColumns ? (row.banReason ?? null) : null,
        bannedAt:
          hasBanColumns && row.bannedAt != null ? new Date(row.bannedAt) : null,
      })),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  async getSingleUser(userId: string): Promise<AdminSingleUserResult> {
    const baseUser = await this.getManageableUserOrThrow(userId);
    const hasSubscriptionsTable = await this.hasSubscriptionsTable();

    const [recordingsCount, rehearsalsCount, latestSubscriptionRaw] =
      await Promise.all([
        this.dataSource
          .getRepository(Recording)
          .createQueryBuilder(ADMIN_RECORDING_ALIAS)
          .where(`${ADMIN_RECORDING_ALIAS}."userId" = :userId`, { userId })
          .andWhere(`${ADMIN_RECORDING_ALIAS}."deletedAt" IS NULL`)
          .getCount(),
        this.dataSource
          .getRepository(Rehersal)
          .createQueryBuilder(ADMIN_REHEARSAL_ALIAS)
          .where(`${ADMIN_REHEARSAL_ALIAS}."userId" = :userId`, { userId })
          .andWhere(`${ADMIN_REHEARSAL_ALIAS}."deletedAt" IS NULL`)
          .getCount(),
        hasSubscriptionsTable
          ? this.dataSource.query(
              `
              SELECT
                s.id,
                s.plan,
                s.status,
                s."expiresAt" AS "expiresAt",
                s."stripeCustomerId" AS "stripeCustomerId",
                s."stripeSubscriptionId" AS "stripeSubscriptionId",
                s."stripePriceId" AS "stripePriceId",
                s."createdAt" AS "createdAt",
                s."updatedAt" AS "updatedAt"
              FROM billing_schema.subscriptions s
              WHERE s."userId" = $1
                AND s."deletedAt" IS NULL
              ORDER BY s."createdAt" DESC
              LIMIT 1
              `,
              [userId],
            )
          : Promise.resolve([]),
      ]);

    const latestSubscription = latestSubscriptionRaw?.[0] ?? null;
    const subscriptionStatus =
      this.deriveSubscriptionStatus(latestSubscription);

    return {
      ...baseUser,
      recordingsCount,
      rehearsalsCount,
      subscriptionStatus,
      subscription: latestSubscription
        ? {
            id: latestSubscription.id,
            plan: latestSubscription.plan,
            status: latestSubscription.status,
            expiresAt: latestSubscription.expiresAt
              ? new Date(latestSubscription.expiresAt)
              : null,
            stripeCustomerId: latestSubscription.stripeCustomerId ?? null,
            stripeSubscriptionId:
              latestSubscription.stripeSubscriptionId ?? null,
            stripePriceId: latestSubscription.stripePriceId ?? null,
            createdAt: latestSubscription.createdAt
              ? new Date(latestSubscription.createdAt)
              : null,
            updatedAt: latestSubscription.updatedAt
              ? new Date(latestSubscription.updatedAt)
              : null,
          }
        : null,
    };
  }

  async listUserRecordings(
    userId: string,
    query: ListUserRecordingsQueryDto,
  ): Promise<PaginatedResult<AdminUserRecordingListItem>> {
    await this.getManageableUserOrThrow(userId);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;

    const rec = ADMIN_RECORDING_ALIAS;
    const proj = ADMIN_PROJECT_ALIAS;
    const scr = 'scr';
    const scn = 'scn';

    const qb = this.dataSource
      .getRepository(Recording)
      .createQueryBuilder(rec)
      .leftJoin(`${rec}.project`, proj)
      .leftJoin(`${rec}.script`, scr)
      .leftJoin(`${rec}.scene`, scn)
      .where(`${rec}."userId" = :userId`, { userId })
      .andWhere(`${rec}."deletedAt" IS NULL`);

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        new Brackets((subQb) => {
          subQb
            .where(`LOWER(COALESCE(${rec}."titleCard", '')) LIKE :term`, {
              term,
            })
            .orWhere(`LOWER(COALESCE(${rec}.summary, '')) LIKE :term`, {
              term,
            })
            .orWhere(`LOWER(COALESCE(${proj}.title, '')) LIKE :term`, { term })
            .orWhere(`LOWER(COALESCE(${scr}.title, '')) LIKE :term`, { term })
            .orWhere(`LOWER(COALESCE(${scn}.heading, '')) LIKE :term`, {
              term,
            });
        }),
      );
    }

    if (query.status) {
      qb.andWhere(`${rec}.status = :status`, { status: query.status });
    }
    if (query.type) {
      qb.andWhere(`${rec}.type = :type`, { type: query.type });
    }
    if (query.projectId) {
      qb.andWhere(`${rec}."projectId" = :projectId`, {
        projectId: query.projectId,
      });
    }
    if (query.sceneId) {
      qb.andWhere(`${rec}."sceneId" = :sceneId`, { sceneId: query.sceneId });
    }
    if (query.createdFrom) {
      qb.andWhere(`${rec}."createdAt" >= :createdFrom`, {
        createdFrom: new Date(query.createdFrom),
      });
    }
    if (query.createdTo) {
      const end = new Date(query.createdTo);
      end.setHours(23, 59, 59, 999);
      qb.andWhere(`${rec}."createdAt" <= :createdTo`, { createdTo: end });
    }

    this.applyRecordingSort(qb, query.sortBy, query.sortOrder, rec);

    const total = await qb.clone().getCount();
    const rows = await qb
      .select([
        `${rec}.id AS "id"`,
        `${rec}."titleCard" AS "titleCard"`,
        `${rec}.summary AS "summary"`,
        `${rec}.status AS "status"`,
        `${rec}.type AS "type"`,
        `${rec}."durationMs" AS "durationMs"`,
        `${rec}."createdAt" AS "createdAt"`,
        `${rec}."updatedAt" AS "updatedAt"`,
        `${rec}."projectId" AS "projectId"`,
        `${rec}."scriptId" AS "scriptId"`,
        `${rec}."sceneId" AS "sceneId"`,
        `${proj}.title AS "projectTitle"`,
        `${scr}.title AS "scriptTitle"`,
        `${scn}.number AS "sceneNumber"`,
        `${scn}.heading AS "sceneHeading"`,
      ])
      .offset(offset)
      .limit(limit)
      .getRawMany<AdminUserRecordingListItem>();

    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data: rows.map((row) => ({
        ...row,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      })),
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  async listUserRehearsals(
    userId: string,
    query: ListUserRehearsalsQueryDto,
  ): Promise<PaginatedResult<AdminUserRehearsalListItem>> {
    await this.getManageableUserOrThrow(userId);
    const result = await this.rehearsalListService.listByUserId(
      userId,
      query as any,
    );
    return result as PaginatedResult<AdminUserRehearsalListItem>;
  }

  private async getManageableUserOrThrow(
    userId: string,
  ): Promise<
    Omit<
      AdminSingleUserResult,
      'recordingsCount' | 'rehearsalsCount' | 'subscription'
    >
  > {
    const u = ADMIN_USER_ALIAS;
    const role = ADMIN_USER_ROLE_ALIAS;
    const userStatusExpr = `
      CASE
        WHEN ${u}."deletedAt" IS NOT NULL THEN 'banned'
        WHEN ${u}."disabled" = true THEN 'deactivated'
        WHEN ${u}."lastLoginAt" IS NULL THEN 'inactive'
        ELSE 'active'
      END
    `;

    const hasBanColumns = await this.hasUserBanColumns();

    const row = await this.dataSource
      .getRepository(User)
      .createQueryBuilder(u)
      .withDeleted()
      .leftJoin(`${u}.role`, role)
      .select([
        `${u}.id AS "id"`,
        `${u}.fullName AS "name"`,
        `${u}.email AS "email"`,
        `${u}.avatar AS "avatar"`,
        `${role}.code AS "accountType"`,
        `${u}."createdAt" AS "createdAt"`,
        `${u}."updatedAt" AS "updatedAt"`,
        `${u}."lastLoginAt" AS "lastLoginAt"`,
        `${u}.disabled AS "disabled"`,
        `${u}."deactivationReason" AS "deactivationReason"`,
        `${u}."deactivatedAt" AS "deactivatedAt"`,
        `${u}."reactivationReason" AS "reactivationReason"`,
        `${u}."reactivatedAt" AS "reactivatedAt"`,
        ...(hasBanColumns
          ? ([
              `${u}."banReason" AS "banReason"`,
              `${u}."bannedAt" AS "bannedAt"`,
            ] as const)
          : []),
      ])
      .addSelect(userStatusExpr, 'userStatus')
      .where(`${u}.id = :userId`, { userId })
      .andWhere(`${role}.code IN (:...allowedRoles)`, {
        allowedRoles: ACTOR_READER_ROLES,
      })
      .getRawOne<{
        id: string;
        name: string | null;
        email: string | null;
        avatar: string | null;
        accountType: string;
        createdAt: Date;
        updatedAt: Date;
        lastLoginAt: Date | null;
        disabled: boolean;
        userStatus: string;
        deactivationReason: string | null;
        deactivatedAt: Date | null;
        reactivationReason: string | null;
        reactivatedAt: Date | null;
        banReason?: string | null;
        bannedAt?: Date | null;
      }>();

    if (!row) {
      throw new NotFoundException('User not found');
    }

    return {
      ...row,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
      lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt) : null,
      disabled: row.disabled,
      userStatus: row.userStatus,
      deactivatedAt: row.deactivatedAt ? new Date(row.deactivatedAt) : null,
      reactivatedAt: row.reactivatedAt ? new Date(row.reactivatedAt) : null,
      banReason: hasBanColumns ? (row.banReason ?? null) : null,
      bannedAt: hasBanColumns && row.bannedAt ? new Date(row.bannedAt) : null,
      subscriptionStatus: 'inactive',
    };
  }

  private deriveSubscriptionStatus(
    subscription: {
      status?: string;
      expiresAt?: string | Date | null;
    } | null,
  ): string {
    if (!subscription || !subscription.status) {
      return 'inactive';
    }

    const status = String(subscription.status).toUpperCase();
    const expiresAt = subscription.expiresAt
      ? new Date(subscription.expiresAt)
      : null;
    const isExpired = expiresAt ? expiresAt < new Date() : false;

    if (status === 'ACTIVE') {
      return isExpired ? 'past_due' : 'subscribed';
    }
    if (status === 'EXPIRED') {
      return 'expired';
    }
    if (status === 'CANCELLED') {
      return 'cancelled';
    }
    return status.toLowerCase();
  }

  private applyRecordingSort(
    qb: any,
    sortBy?: UserRecordingSortBy,
    sortOrder: UserListSortOrder = UserListSortOrder.DESC,
    recAlias: string = ADMIN_RECORDING_ALIAS,
  ) {
    if (sortBy === UserRecordingSortBy.UPDATED_AT) {
      qb.orderBy(`${recAlias}."updatedAt"`, sortOrder);
      return;
    }
    if (sortBy === UserRecordingSortBy.DURATION) {
      qb.orderBy(`${recAlias}."durationMs"`, sortOrder, 'NULLS LAST');
      return;
    }
    if (sortBy === UserRecordingSortBy.TITLE) {
      qb.orderBy(`${recAlias}."titleCard"`, sortOrder, 'NULLS LAST');
      return;
    }
    qb.orderBy(`${recAlias}."createdAt"`, sortOrder);
  }
}
