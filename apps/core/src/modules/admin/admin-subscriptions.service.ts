import { SubscriptionPlan, SubscriptionStatus, User } from '@app/common';
import { Injectable } from '@nestjs/common';
import { Brackets, DataSource } from 'typeorm';
import { Subscription } from '../subscription/entities/subscription.entity';
import {
  AdminSubscriptionSortBy,
  AdminSubscriptionSortOrder,
  ListSubscriptionsQueryDto,
} from './dto/list-subscriptions-query.dto';
import {
  ADMIN_SUBSCRIBER_ALIAS,
  ADMIN_SUBSCRIPTION_ALIAS,
} from './admin-query-aliases';

export interface AdminSubscriptionListItem {
  id: string;
  userId: string;
  plan: SubscriptionPlan;
  planName: string;
  stripeSubscriptionId: string | null;
  stripeSubscriptionIdLabel: string;
  renewalDate: Date | null;
  renewalDateLabel: string;
  planStatus: SubscriptionStatus | null;
  planStatusLabel: string;
  createdAt: Date;
  subscriber: {
    fullName: string | null;
    email: string | null;
  };
}

export interface PaginatedAdminSubscriptionsResult {
  data: AdminSubscriptionListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

@Injectable()
export class AdminSubscriptionsService {
  constructor(private readonly dataSource: DataSource) {}

  async listSubscriptions(
    query: ListSubscriptionsQueryDto,
  ): Promise<PaginatedAdminSubscriptionsResult> {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;

    const qb = this.startFromAllSubscriptions();
    this.applyStoryFilters(qb, query);
    this.applyStorySorting(qb, query.sortBy, query.sortOrder);

    const total = await qb.clone().getCount();
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    const subr = ADMIN_SUBSCRIBER_ALIAS;
    const rows = await qb
      .select([
        `${sub}.id AS "id"`,
        `${sub}."userId" AS "userId"`,
        `${sub}.plan AS "plan"`,
        `${sub}.status AS "status"`,
        `${sub}."expiresAt" AS "expiresAt"`,
        `${sub}."stripeSubscriptionId" AS "stripeSubscriptionId"`,
        `${sub}."createdAt" AS "createdAt"`,
        `${subr}.fullName AS "subscriberFullName"`,
        `${subr}.email AS "subscriberEmail"`,
      ])
      .offset(offset)
      .limit(limit)
      .getRawMany<{
        id: string;
        userId: string;
        plan: SubscriptionPlan;
        status: SubscriptionStatus;
        expiresAt: Date | null;
        stripeSubscriptionId: string | null;
        createdAt: Date;
        subscriberFullName: string | null;
        subscriberEmail: string | null;
      }>();

    const data = rows.map((row) => this.tellStoryForSubscription(row));
    const totalPages = Math.ceil(total / limit) || 1;
    return {
      data,
      total,
      page,
      limit,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  private startFromAllSubscriptions() {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    const subr = ADMIN_SUBSCRIBER_ALIAS;
    return this.dataSource
      .getRepository(Subscription)
      .createQueryBuilder(sub)
      .leftJoin(User, subr, `${subr}.id = ${sub}."userId"`)
      .where(`${sub}."deletedAt" IS NULL`);
  }

  private applyStoryFilters(qb: any, query: ListSubscriptionsQueryDto): void {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    const subr = ADMIN_SUBSCRIBER_ALIAS;

    if (query.search?.trim()) {
      const term = `%${query.search.trim().toLowerCase()}%`;
      qb.andWhere(
        new Brackets((subQb) => {
          subQb
            .where(
              `LOWER(COALESCE(${sub}."stripeSubscriptionId", '')) LIKE :term`,
              { term },
            )
            .orWhere(
              `
                LOWER(
                  CASE ${sub}.plan
                    WHEN 'FREE' THEN 'free'
                    WHEN 'STARTER' THEN 'pro monthly ($45)'
                    WHEN 'PREMIUM' THEN 'studio monthly ($80)'
                    WHEN 'ALL_ACCESS' THEN 'all access'
                    ELSE LOWER(${sub}.plan::text)
                  END
                ) LIKE :term
              `,
              { term },
            )
            .orWhere(`LOWER(COALESCE(${sub}.plan::text, '')) LIKE :term`, {
              term,
            })
            .orWhere(`LOWER(COALESCE(${subr}.fullName, '')) LIKE :term`, {
              term,
            })
            .orWhere(`LOWER(COALESCE(${subr}.email, '')) LIKE :term`, {
              term,
            });
        }),
      );
    }

    if (query.plan) {
      qb.andWhere(`${sub}.plan = :plan`, { plan: query.plan });
    }

    if (query.status) {
      qb.andWhere(`${sub}.status = :status`, { status: query.status });
    }

    if (query.createdFrom) {
      qb.andWhere(`${sub}."createdAt" >= :createdFrom`, {
        createdFrom: new Date(query.createdFrom),
      });
    }

    if (query.createdTo) {
      const end = new Date(query.createdTo);
      end.setHours(23, 59, 59, 999);
      qb.andWhere(`${sub}."createdAt" <= :createdTo`, { createdTo: end });
    }
  }

  private applyStorySorting(
    qb: any,
    sortBy: AdminSubscriptionSortBy = AdminSubscriptionSortBy.CREATED_AT,
    sortOrder: AdminSubscriptionSortOrder = AdminSubscriptionSortOrder.DESC,
  ): void {
    const sub = ADMIN_SUBSCRIPTION_ALIAS;
    if (sortBy === AdminSubscriptionSortBy.PLAN_NAME) {
      qb.orderBy(`${sub}.plan`, sortOrder);
      return;
    }
    if (sortBy === AdminSubscriptionSortBy.RENEWAL_DATE) {
      qb.orderBy(`${sub}."expiresAt"`, sortOrder, 'NULLS LAST');
      return;
    }
    if (sortBy === AdminSubscriptionSortBy.PLAN_STATUS) {
      qb.orderBy(`${sub}.status`, sortOrder, 'NULLS LAST');
      return;
    }
    qb.orderBy(`${sub}."createdAt"`, sortOrder);
  }

  private tellStoryForSubscription(row: {
    id: string;
    userId: string;
    plan: SubscriptionPlan;
    status: SubscriptionStatus;
    expiresAt: Date | null;
    stripeSubscriptionId: string | null;
    createdAt: Date;
    subscriberFullName: string | null;
    subscriberEmail: string | null;
  }): AdminSubscriptionListItem {
    const isFreePlan = row.plan === SubscriptionPlan.FREE;

    return {
      id: row.id,
      userId: row.userId,
      plan: row.plan,
      planName: this.humanizePlanName(row.plan),
      stripeSubscriptionId: row.stripeSubscriptionId ?? null,
      stripeSubscriptionIdLabel: row.stripeSubscriptionId ?? '---',
      renewalDate: isFreePlan
        ? null
        : row.expiresAt
          ? new Date(row.expiresAt)
          : null,
      renewalDateLabel: isFreePlan
        ? 'Unlimited'
        : row.expiresAt
          ? 'Scheduled'
          : '--',
      planStatus: isFreePlan ? null : (row.status ?? null),
      planStatusLabel: isFreePlan ? '---' : this.humanizeStatus(row.status),
      createdAt: new Date(row.createdAt),
      subscriber: {
        fullName: row.subscriberFullName ?? null,
        email: row.subscriberEmail ?? null,
      },
    };
  }

  private humanizePlanName(plan: SubscriptionPlan): string {
    if (plan === SubscriptionPlan.FREE) {
      return 'Free';
    }
    if (plan === SubscriptionPlan.STARTER) {
      return 'Pro Monthly ($45)';
    }
    if (plan === SubscriptionPlan.PREMIUM) {
      return 'Studio Monthly ($80)';
    }
    if (plan === SubscriptionPlan.ALL_ACCESS) {
      return 'All Access';
    }
    return plan;
  }

  private humanizeStatus(status: SubscriptionStatus): string {
    if (status === SubscriptionStatus.ACTIVE) {
      return 'Active';
    }
    if (status === SubscriptionStatus.CANCELLED) {
      return 'Cancelled';
    }
    if (status === SubscriptionStatus.EXPIRED) {
      return 'Expired';
    }
    return status;
  }
}
