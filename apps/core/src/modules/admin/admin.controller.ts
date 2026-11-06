/** biome-ignore-all lint/style/useImportType: <> */

import {
  AdminPermission,
  AuditLogAction,
  AuditService,
  JwtAuthGuard,
  PermissionsGuard,
  RequirePermission,
  RequireSubscriptionOrBillingGuard,
  Roles,
  RolesGuard,
  UserRole,
} from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Patch,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { BookingService } from '../marketplace/booking/booking.service';
import { SessionLifecycleService } from '../marketplace/booking/session-lifecycle.service';
import { AdminContentModerationService } from './admin-content-moderation.service';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminProjectsService } from './admin-projects.service';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { AdminUsersService } from './admin-users.service';
import { AdminUserRolesService } from './admin-user-roles.service';
import { QueueMonitorService } from './queue-monitor.service';
import { ProjectListService } from '../project/project-list.service';
import { ProjectService } from '../project/project.service';
import { ListProjectOutboxJobsDto } from '../project/dto/list-project-outbox-jobs.dto';
import { ListProjectsByUserIdQueryDto } from '../project/dto/list-projects-by-user-query.dto';
import { AdminBookingsService } from './admin-bookings.service';
import { CreateUserRoleDto } from './dto/create-user-role.dto';
import { DeleteContentDto } from './dto/delete-content.dto';
import { FlagProjectDto } from './dto/flag-project.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { AdminMetricsQueryDto } from './dto/admin-metrics-query.dto';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { ListSubscriptionsQueryDto } from './dto/list-subscriptions-query.dto';
import {
  ListUserRecordingsQueryDto,
  ListUserRehearsalsQueryDto,
  ListUsersQueryDto,
} from './dto/list-users-query.dto';
import { PaymentsSummaryDto } from './dto/payments-summary.dto';
import { PlatformMetricsDto } from './dto/platform-metrics.dto';
import { ExtendedUsageMetricsDto } from './dto/extended-usage-metrics.dto';
import { ListAdminBookingsQueryDto } from './dto/list-admin-bookings-query.dto';
import { TokenMetricsDto } from './dto/token-metrics.dto';
import { ResolveNoShowDto } from './dto/resolve-no-show.dto';
import { UserMetricsDto } from './dto/user-metrics.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

@ApiTags('Admin')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SYSTEM_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly sessionLifecycleService: SessionLifecycleService,
    private readonly bookingService: BookingService,
    private readonly adminContentModerationService: AdminContentModerationService,
    private readonly adminMetricsService: AdminMetricsService,
    private readonly adminPaymentsService: AdminPaymentsService,
    private readonly adminProjectsService: AdminProjectsService,
    private readonly adminSubscriptionsService: AdminSubscriptionsService,
    private readonly adminUsersService: AdminUsersService,
    private readonly adminUserRolesService: AdminUserRolesService,
    private readonly auditService: AuditService,
    private readonly projectListService: ProjectListService,
    private readonly projectService: ProjectService,
    private readonly adminBookingsService: AdminBookingsService,
    private readonly queueMonitorService: QueueMonitorService,
  ) {}

  @Get('metrics/users')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.USER_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Get user overview metrics',
    description:
      'Returns user-level dashboard metrics for the selected date window. Includes total signups (actor/reader users created in range) and active users (actor/reader users who logged in during range and are not disabled/soft-deleted). If no date filters are supplied, the API defaults to the last 7 days.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'Start of reporting range (ISO 8601, inclusive). Example: 2026-05-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'End of reporting range (ISO 8601, inclusive). Example: 2026-05-06T23:59:59.999Z',
  })
  @ApiOkResponse({
    description: 'User metrics retrieved successfully',
    type: UserMetricsDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid date values or from is later than to. Values must be ISO 8601 date strings.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Requires system_admin or app_admin with user_view permission',
  })
  async getUserMetrics(
    @Query(new ValidationPipe({ transform: true }))
    query: AdminMetricsQueryDto,
  ): Promise<UserMetricsDto> {
    return this.adminMetricsService.getUserMetrics(query);
  }

  @Get('metrics/platform')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.PROJECT_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Get platform overview metrics',
    description:
      'Returns platform-level dashboard metrics for the selected date window. Includes projects created, process-based uptime percentage across the selected window, plus request-derived average latency and 5xx error rate. If no date filters are supplied, the API defaults to the last 7 days.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'Start of reporting range (ISO 8601, inclusive). Example: 2026-05-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'End of reporting range (ISO 8601, inclusive). Example: 2026-05-06T23:59:59.999Z',
  })
  @ApiOkResponse({
    description: 'Platform metrics retrieved successfully',
    type: PlatformMetricsDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid date values or from is later than to. Values must be ISO 8601 date strings.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with project_view permission',
  })
  async getPlatformMetrics(
    @Query(new ValidationPipe({ transform: true }))
    query: AdminMetricsQueryDto,
  ): Promise<PlatformMetricsDto> {
    return this.adminMetricsService.getPlatformMetrics(query);
  }

  @Get('metrics/tokens')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(
    AdminPermission.BILLING_VIEW,
    AdminPermission.SUBSCRIPTION_VIEW,
  )
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Get Gemini token usage metrics',
    description:
      "Returns aggregated usage from `billing_schema.usage_records` for the selected window: Gemini tokens (`gemini_tokens`) and ElevenLabs characters (`elevenlabs_characters`), keyed on each row's `createdAt`. Includes the immediately preceding period of the same duration (non-overlapping) plus deltas for week-over-week style UI. Optional USD estimates are returned when env vars `ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS` and/or `ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS` are set (rates multiply quantity ÷ 1e6). Defaults to the last 7 days when `from` / `to` are omitted. Requires billing_view or subscription_view.",
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'Start of reporting range (ISO 8601, inclusive). Example: 2026-05-01T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'End of reporting range (ISO 8601, inclusive). Example: 2026-05-06T23:59:59.999Z',
  })
  @ApiOkResponse({
    description: 'Token metrics retrieved successfully',
    type: TokenMetricsDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid date values or from is later than to. Values must be ISO 8601 date strings.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with billing_view or subscription_view',
  })
  async getTokenMetrics(
    @Query(new ValidationPipe({ transform: true }))
    query: AdminMetricsQueryDto,
  ): Promise<TokenMetricsDto> {
    return this.adminMetricsService.getTokenMetrics(query);
  }

  @Get('metrics/usage')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.BILLING_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Get extended platform usage metrics (Deepgram, Agora, S3)',
    description:
      'Additive metrics endpoint. Does not change `GET metrics/tokens` response shape. Includes Deepgram minutes, Agora minutes, and S3 storage bytes from `billing_schema.usage_records`.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiOkResponse({
    description: 'Extended usage metrics retrieved successfully',
    type: ExtendedUsageMetricsDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid date filter values' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Requires system_admin or app_admin with billing_view',
  })
  async getExtendedUsageMetrics(
    @Query(new ValidationPipe({ transform: true }))
    query: AdminMetricsQueryDto,
  ): Promise<ExtendedUsageMetricsDto> {
    return this.adminMetricsService.getExtendedUsageMetrics(query);
  }

  @Get('users')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.USER_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List actors/readers with search, filters, and pagination',
    description:
      'Returns paginated users for User Management (actors and readers only). Supports search by email/full name, role filter, user status filter, subscription status filter, created date range, and sorting. System admins can access freely; app admins require user_view permission.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    description: 'Page number (1-indexed)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 20,
    description: 'Page size (max 100)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by name or email',
    example: 'james@gmail.com',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['actor', 'reader'],
    description: 'Filter by account type (role code)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['active', 'inactive', 'deactivated', 'banned'],
    description:
      'Filter by user status badge shown in UI (derived from deletedAt/disabled/lastLoginAt)',
  })
  @ApiQuery({
    name: 'subscriptionStatus',
    required: false,
    enum: [
      'subscribed',
      'active',
      'past_due',
      'inactive',
      'expired',
      'cancelled',
    ],
    description: 'Filter by latest subscription status badge shown in UI',
  })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    type: String,
    description: 'Filter users created on/after date (YYYY-MM-DD)',
    example: '2026-01-01',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    type: String,
    description: 'Filter users created on/before date (YYYY-MM-DD)',
    example: '2026-02-21',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'name', 'email'],
    description: 'Sort field',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated user list',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: {
                type: 'string',
                nullable: true,
                example: 'Bessie Cooper',
              },
              email: {
                type: 'string',
                nullable: true,
                example: 'bihan628@gmail.com',
              },
              avatar: {
                type: 'string',
                nullable: true,
                example: 'https://example.com/avatar.jpg',
              },
              accountType: { type: 'string', example: 'actor' },
              createdAt: { type: 'string', format: 'date-time' },
              userStatus: {
                type: 'string',
                enum: ['active', 'inactive', 'deactivated', 'banned'],
              },
              subscriptionStatus: {
                type: 'string',
                enum: [
                  'subscribed',
                  'active',
                  'past_due',
                  'inactive',
                  'expired',
                  'cancelled',
                ],
              },
              deactivationReason: {
                type: 'string',
                nullable: true,
                example: 'Violation of platform policy',
              },
              deactivatedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
              reactivationReason: {
                type: 'string',
                nullable: true,
                example: 'Appeal accepted after manual review',
              },
              reactivatedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
            },
          },
        },
        total: { type: 'number', example: 130 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 20 },
        totalPages: { type: 'number', example: 7 },
        hasNext: { type: 'boolean', example: true },
        hasPrev: { type: 'boolean', example: false },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation error for query params (invalid enum/date/page/limit)',
    schema: {
      example: {
        statusCode: 400,
        message: ['createdFrom must be a valid ISO 8601 date string'],
        error: 'Bad Request',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        statusCode: 401,
        message: 'Unauthorized',
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Requires system_admin or app_admin with user_view permission',
    schema: {
      example: {
        statusCode: 403,
        message: 'Forbidden resource',
      },
    },
  })
  async listUsers(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true }))
    query: ListUsersQueryDto,
  ) {
    const result = await this.adminUsersService.listUsers(query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_USERS,
      resourceType: 'users',
      metadata: {
        page: result.page,
        limit: result.limit,
        total: result.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('projects/enriched')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(
    AdminPermission.PROJECT_VIEW,
    AdminPermission.ACCESS_FLAGGED_CONTENT,
  )
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List projects with analysis pipeline fields (additive API)',
    description:
      'Same filters/pagination as `GET projects`, plus `status`, `analysisState`, and script count summaries. Use this endpoint when the admin UI needs analysis context; `GET projects` response shape is unchanged.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({
    name: 'tab',
    required: false,
    enum: ['all', 'flagged', 'reviewed'],
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['name', 'uploadedDate', 'createdBy', 'flaggedAt'],
  })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['ASC', 'DESC'] })
  @ApiOkResponse({ description: 'Paginated enriched projects' })
  async listProjectsEnriched(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true }))
    query: ListProjectsQueryDto,
  ) {
    const result = await this.adminProjectsService.listProjectsEnriched(query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_PROJECTS_ENRICHED,
      resourceType: 'projects',
      metadata: {
        page: result.page,
        limit: result.limit,
        total: result.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('projects')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(
    AdminPermission.PROJECT_VIEW,
    AdminPermission.ACCESS_FLAGGED_CONTENT,
  )
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List projects for project management',
    description:
      'Returns paginated projects with owner details and current flag state. Supports tabs (all/flagged/reviewed), search, and sorting. System admins can access freely; app admins require project_view or access_flagged_content permission.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by project name, creator full name, or creator email',
  })
  @ApiQuery({
    name: 'tab',
    required: false,
    enum: ['all', 'flagged', 'reviewed'],
    description: 'UI tab filter',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['name', 'uploadedDate', 'createdBy', 'flaggedAt'],
    description: 'Sort field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
  })
  @ApiOkResponse({
    description: 'Paginated projects',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string', example: 'Little Woman scene 1' },
              uploadedDate: { type: 'string', format: 'date-time' },
              isFlagged: { type: 'boolean', example: false },
              flagStatus: { type: 'string', enum: ['flagged', 'not_flagged'] },
              createdBy: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  fullName: {
                    type: 'string',
                    nullable: true,
                    example: 'Bessie Cooper',
                  },
                  email: {
                    type: 'string',
                    nullable: true,
                    example: 'bessiecooper@gmail.com',
                  },
                  avatar: { type: 'string', nullable: true },
                },
              },
              latestFlag: {
                type: 'object',
                nullable: true,
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  status: { type: 'string', enum: ['PENDING', 'REVIEWED'] },
                  reason: { type: 'string', nullable: true },
                  flaggedAt: { type: 'string', format: 'date-time' },
                  flaggedBy: {
                    type: 'object',
                    properties: {
                      userId: {
                        type: 'string',
                        format: 'uuid',
                        nullable: true,
                      },
                      name: { type: 'string', nullable: true },
                      email: { type: 'string', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        total: { type: 'number', example: 130 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 20 },
        totalPages: { type: 'number', example: 7 },
        hasNext: { type: 'boolean', example: true },
        hasPrev: { type: 'boolean', example: false },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation error for query params' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async listProjects(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true }))
    query: ListProjectsQueryDto,
  ) {
    const result = await this.adminProjectsService.listProjects(query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_PROJECTS,
      resourceType: 'projects',
      metadata: {
        page: result.page,
        limit: result.limit,
        total: result.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('subscriptions')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.SUBSCRIPTION_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List all subscriptions for admin project billing view',
    description:
      'Returns paginated subscriptions matching the billing table experience. Supports search by Stripe subscription ID or plan name, filtering, and sorting. System admins can access freely; app admins require subscription_view permission.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search sub ID or plan name',
    example: 'sub_OLx9yZaBcDeFGHIJKLMN',
  })
  @ApiQuery({
    name: 'plan',
    required: false,
    enum: ['FREE', 'STARTER', 'PREMIUM', 'ALL_ACCESS'],
    description: 'Filter by plan',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'EXPIRED', 'CANCELLED'],
    description: 'Filter by plan status',
  })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    type: String,
    description: 'Filter records created on/after date (YYYY-MM-DD)',
    example: '2026-01-01',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    type: String,
    description: 'Filter records created on/before date (YYYY-MM-DD)',
    example: '2026-02-28',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'renewalDate', 'planName', 'planStatus'],
    description: 'Sort field',
    example: 'createdAt',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
    example: 'DESC',
  })
  @ApiOkResponse({
    description: 'Paginated subscriptions list',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              plan: { type: 'string', example: 'STARTER' },
              planName: { type: 'string', example: 'Pro Monthly ($45)' },
              stripeSubscriptionId: {
                type: 'string',
                nullable: true,
                example: 'sub_OLx9yZaBcDeFGHIJKLMN',
              },
              stripeSubscriptionIdLabel: {
                type: 'string',
                example: 'sub_OLx9yZaBcDeFGHIJKLMN',
              },
              renewalDate: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
              renewalDateLabel: { type: 'string', example: 'Unlimited' },
              planStatus: { type: 'string', nullable: true, example: 'ACTIVE' },
              planStatusLabel: { type: 'string', example: 'Active' },
              createdAt: { type: 'string', format: 'date-time' },
              subscriber: {
                type: 'object',
                properties: {
                  fullName: {
                    type: 'string',
                    nullable: true,
                    example: 'Bessie Cooper',
                  },
                  email: {
                    type: 'string',
                    nullable: true,
                    example: 'bessiecooper@gmail.com',
                  },
                },
              },
            },
          },
        },
        total: { type: 'number', example: 130 },
        page: { type: 'number', example: 1 },
        limit: { type: 'number', example: 20 },
        totalPages: { type: 'number', example: 7 },
        hasNext: { type: 'boolean', example: true },
        hasPrev: { type: 'boolean', example: false },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error for query params',
    schema: {
      example: {
        statusCode: 400,
        message: [
          'status must be one of the following values: ACTIVE, EXPIRED, CANCELLED',
        ],
        error: 'Bad Request',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with subscription_view permission',
  })
  async listSubscriptions(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true }))
    query: ListSubscriptionsQueryDto,
  ) {
    const result =
      await this.adminSubscriptionsService.listSubscriptions(query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_SUBSCRIPTIONS,
      resourceType: 'subscriptions',
      metadata: {
        page: result.page,
        limit: result.limit,
        total: result.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('payments/summary')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'Get payments dashboard summary',
    description:
      'Returns summary metrics for the Payments dashboard: total active subscriptions, MRR, refunds total, and failed payments count. Requires system admin or app admin with subscription/billing permission.',
  })
  @ApiOkResponse({
    description: 'Payments summary metrics',
    type: PaymentsSummaryDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Requires system admin or app admin with subscription/billing permission',
  })
  async getPaymentsSummary(@Req() req: any): Promise<PaymentsSummaryDto> {
    const result = await this.adminPaymentsService.getPaymentsSummary();
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_GET_PAYMENTS_SUMMARY,
      resourceType: 'payments',
      metadata: {
        totalActiveSubs: result.totalActiveSubs,
        totalActiveSubsChange: result.totalActiveSubsChange,
        mrr: result.mrr,
        mrrChange: result.mrrChange,
        refundsTotal: result.refundsTotal,
        failedPaymentsCount: result.failedPaymentsCount,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('payments/reconciliation-issues')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'List payment reconciliation issues requiring review',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listPaymentReconciliationIssues(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result =
      await this.adminPaymentsService.listPaymentReconciliationIssues({
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20,
      });

    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_PAYMENT_RECONCILIATION_ISSUES,
      resourceType: 'payment_records',
      metadata: {
        page: result.data.page,
        limit: result.data.limit,
        total: result.data.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });

    return result;
  }

  @Get('payments/settlement-issues')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'List separate-charge settlement issues (failed or overdue)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listSettlementIssues(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.adminPaymentsService.listSettlementIssues({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_SETTLEMENT_ISSUES,
      resourceType: 'payment_records',
      metadata: {
        page: result.data.page,
        limit: result.data.limit,
        total: result.data.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('payments/financial-reconciliation-issues')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary:
      'List financial reconciliation issues with full booking financial state',
    description:
      'Additive API using `buildBookingFinancialState` (includes settlement, refund, and manual-review codes). Does not change `GET payments/reconciliation-issues`.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listFinancialReconciliationIssues(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result =
      await this.adminPaymentsService.listFinancialReconciliationIssues({
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20,
      });
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_FINANCIAL_RECONCILIATION_ISSUES,
      resourceType: 'payment_records',
      metadata: {
        page: result.data.page,
        limit: result.data.limit,
        total: result.data.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Post('bookings/:id/refund-retry')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'Retry a failed booking refund from the last recorded attempt',
  })
  async retryBookingRefund(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
  ) {
    const result =
      await this.adminPaymentsService.retryBookingRefund(bookingId);

    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_RETRY_BOOKING_REFUND,
      resourceType: 'booking',
      resourceId: bookingId,
      metadata: {
        refundId: result.refundId,
        transferReversalId: result.transferReversalId,
        refundStatus: result.refundStatus,
        reversalStatus: result.reversalStatus,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });

    return {
      success: true,
      message: 'Booking refund retry processed',
      data: result,
    };
  }

  @Post('bookings/:id/settlement-retry')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'Retry a failed separate-charge settlement for a booking',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiBadRequestResponse({
    description: 'Settlement retry not applicable or failed',
  })
  async retryBookingSettlement(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
  ) {
    const result =
      await this.adminPaymentsService.retryBookingSettlement(bookingId);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_RETRY_BOOKING_SETTLEMENT,
      resourceType: 'booking',
      resourceId: bookingId,
      metadata: result,
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return {
      success: true,
      message: 'Booking settlement retry processed',
      data: result,
    };
  }

  @Post('projects/:projectId/flag')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.CONTENT_MODERATE)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Flag a project',
    description:
      'Flags a project for moderation and records who flagged it, when, and optional reason. Requires content_moderate permission.',
  })
  @ApiParam({ name: 'projectId', description: 'Project ID (UUID)' })
  @ApiBody({ type: FlagProjectDto })
  @ApiOkResponse({
    description: 'Project flagged successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Project flagged successfully' },
        projectId: { type: 'string', format: 'uuid' },
        isFlagged: { type: 'boolean', example: true },
        latestFlag: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['PENDING', 'REVIEWED'] },
            reason: { type: 'string', nullable: true },
            flaggedAt: { type: 'string', format: 'date-time' },
            flaggedBy: {
              type: 'object',
              properties: {
                userId: { type: 'string', format: 'uuid', nullable: true },
                name: { type: 'string', nullable: true },
                email: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Project not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with content_moderate permission',
  })
  async flagProject(
    @Req() req: any,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(ValidationPipe) dto: FlagProjectDto,
  ) {
    const result = await this.adminProjectsService.flagProject(
      projectId,
      req.user?.id,
      dto.reason,
    );
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_FLAG_PROJECT,
      resourceType: 'project',
      resourceId: projectId,
      metadata: { reason: dto.reason, isFlagged: result.isFlagged },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('projects/:projectId/outbox-jobs')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.PROJECT_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Inspect analysis outbox jobs for any project (admin)',
    description:
      'Admin bypass of owner-scoped `GET projects/:id/outbox-jobs`. Same response shape as the user-facing debug endpoint.',
  })
  @ApiParam({ name: 'projectId', description: 'Project ID (UUID)' })
  async getProjectOutboxJobs(
    @Req() req: any,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query(new ValidationPipe({ transform: true }))
    query: ListProjectOutboxJobsDto,
  ) {
    const result = await this.projectService.getProjectOutboxJobsForAdmin(
      projectId,
      query,
    );
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_GET_PROJECT_OUTBOX_JOBS,
      resourceType: 'project',
      resourceId: projectId,
      metadata: { filters: query },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Post('projects/:projectId/scripts/:scriptId/retry-analysis')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.PROJECT_EDIT)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Retry failed script analysis for a project (admin)',
    description:
      'Admin bypass of owner-scoped script retry. Only failed scripts with a source media reference can be retried.',
  })
  @ApiParam({ name: 'projectId', description: 'Project ID (UUID)' })
  @ApiParam({ name: 'scriptId', description: 'Script ID (UUID)' })
  async retryProjectScriptAnalysis(
    @Req() req: any,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('scriptId', ParseUUIDPipe) scriptId: string,
  ) {
    const result = await this.projectService.retryProjectScriptAnalysisForAdmin(
      projectId,
      scriptId,
    );
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_RETRY_PROJECT_SCRIPT_ANALYSIS,
      resourceType: 'script',
      resourceId: scriptId,
      metadata: { projectId },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Post('content/:contentId/delete')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.CONTENT_DELETE)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Permanently delete moderated content',
    description:
      'Deletes script/recording/media content and performs cleanup to prevent orphan references (join rows and orphan media).',
  })
  @ApiParam({ name: 'contentId', description: 'Content ID (UUID)' })
  @ApiBody({ type: DeleteContentDto })
  @ApiOkResponse({
    description: 'Content deleted with cleanup summary',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Content deleted successfully' },
        contentId: { type: 'string', format: 'uuid' },
        contentType: { type: 'string', enum: ['script', 'recording', 'media'] },
        deletedAt: { type: 'string', format: 'date-time' },
        cleanup: {
          type: 'object',
          properties: {
            detachedRelations: { type: 'number', example: 4 },
            deletedOrphanMediaCount: { type: 'number', example: 1 },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Content not found' })
  @ApiBadRequestResponse({ description: 'Validation error for content type' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with content_delete permission',
  })
  async deleteContent(
    @Req() req: any,
    @Param('contentId', ParseUUIDPipe) contentId: string,
    @Body(ValidationPipe) dto: DeleteContentDto,
  ) {
    const result = await this.adminContentModerationService.deleteContent(
      contentId,
      dto.contentType,
    );
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_DELETE_CONTENT,
      resourceType: dto.contentType,
      resourceId: contentId,
      metadata: { contentType: dto.contentType, cleanup: result.cleanup },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('users/:userId')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.USER_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Get single actor/reader user details',
    description:
      'Returns one user profile for User Management with latest subscription details and aggregated usage counts (recordings, rehearsals). System admins can access freely; app admins require user_view permission.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiOkResponse({
    description: 'User details',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string', nullable: true },
        email: { type: 'string', nullable: true },
        accountType: { type: 'string', example: 'actor' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
        disabled: { type: 'boolean' },
        userStatus: {
          type: 'string',
          enum: ['active', 'inactive', 'deactivated', 'banned'],
        },
        subscriptionStatus: {
          type: 'string',
          enum: [
            'subscribed',
            'active',
            'past_due',
            'inactive',
            'expired',
            'cancelled',
          ],
        },
        recordingsCount: { type: 'number', example: 18 },
        rehearsalsCount: { type: 'number', example: 25 },
        deactivationReason: { type: 'string', nullable: true },
        deactivatedAt: { type: 'string', format: 'date-time', nullable: true },
        reactivationReason: { type: 'string', nullable: true },
        reactivatedAt: { type: 'string', format: 'date-time', nullable: true },
        banReason: { type: 'string', nullable: true },
        bannedAt: { type: 'string', format: 'date-time', nullable: true },
        subscription: {
          type: 'object',
          nullable: true,
          properties: {
            id: { type: 'string', format: 'uuid' },
            plan: { type: 'string', example: 'PREMIUM' },
            status: { type: 'string', example: 'ACTIVE' },
            expiresAt: { type: 'string', format: 'date-time', nullable: true },
            stripeCustomerId: { type: 'string', nullable: true },
            stripeSubscriptionId: { type: 'string', nullable: true },
            stripePriceId: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Requires system_admin or app_admin with user_view permission',
  })
  async getSingleUser(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const result = await this.adminUsersService.getSingleUser(userId);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_GET_USER,
      resourceType: 'user',
      resourceId: userId,
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('users/:userId/projects')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.PROJECT_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List projects by user ID',
    description:
      'Returns paginated projects for a user with full details (scenes, recordings, rehearsals counts, default character name). System admins can access freely; app admins require project_view permission.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by title, description, or default character name',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Filter by project status',
  })
  @ApiQuery({ name: 'scenesMin', required: false, type: Number })
  @ApiQuery({ name: 'scenesMax', required: false, type: Number })
  @ApiQuery({ name: 'recordingsMin', required: false, type: Number })
  @ApiQuery({ name: 'recordingsMax', required: false, type: Number })
  @ApiQuery({ name: 'rehearsalsMin', required: false, type: Number })
  @ApiQuery({ name: 'rehearsalsMax', required: false, type: Number })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    type: String,
    description:
      'Sort field: createdAt, updatedAt, title, scenesCount, recordingsCount, rehearsalsCount',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort direction',
  })
  @ApiOkResponse({
    description: 'Paginated projects with details',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              userId: { type: 'string', format: 'uuid' },
              title: { type: 'string' },
              description: { type: 'string', nullable: true },
              status: { type: 'string' },
              isFlagged: { type: 'boolean' },
              defaultCharacterName: { type: 'string', nullable: true },
              scenesCount: { type: 'number' },
              recordingsCount: { type: 'number' },
              rehearsalsCount: { type: 'number' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
        totalPages: { type: 'number' },
        hasNext: { type: 'boolean' },
        hasPrev: { type: 'boolean' },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with project_view permission',
  })
  async listUserProjects(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query(new ValidationPipe({ transform: true }))
    query: ListProjectsByUserIdQueryDto,
  ) {
    const result = await this.projectListService.listByUserId(userId, query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_USER_PROJECTS,
      resourceType: 'user',
      resourceId: userId,
      metadata: {
        page: result.page,
        limit: result.limit,
        total: result.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('users/:userId/recordings')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.USER_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List recordings by user ID',
    description:
      'Returns paginated recordings for a specific actor/reader user. Supports search, filters, and sorting.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search by title card, summary, project/script title, or scene heading',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Recording status',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    type: String,
    description: 'Recording type',
  })
  @ApiQuery({
    name: 'projectId',
    required: false,
    type: String,
    description: 'Filter by project ID (UUID)',
  })
  @ApiQuery({
    name: 'sceneId',
    required: false,
    type: String,
    description: 'Filter by scene ID (UUID)',
  })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    type: String,
    description: 'Created from date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    type: String,
    description: 'Created to date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['createdAt', 'updatedAt', 'duration', 'title'],
    description: 'Sort field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiOkResponse({
    description: 'Paginated recordings',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              titleCard: { type: 'string', nullable: true },
              summary: { type: 'string', nullable: true },
              status: { type: 'string' },
              type: { type: 'string' },
              durationMs: { type: 'number', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              projectId: { type: 'string', format: 'uuid' },
              projectTitle: { type: 'string', nullable: true },
              scriptId: { type: 'string', format: 'uuid' },
              scriptTitle: { type: 'string', nullable: true },
              sceneId: { type: 'string', format: 'uuid' },
              sceneNumber: { type: 'number', nullable: true },
              sceneHeading: { type: 'string', nullable: true },
            },
          },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
        totalPages: { type: 'number' },
        hasNext: { type: 'boolean' },
        hasPrev: { type: 'boolean' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation error for query params' })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Requires system_admin or app_admin with user_view permission',
  })
  async listUserRecordings(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query(new ValidationPipe({ transform: true }))
    query: ListUserRecordingsQueryDto,
  ) {
    const result = await this.adminUsersService.listUserRecordings(
      userId,
      query,
    );
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_USER_RECORDINGS,
      resourceType: 'user',
      resourceId: userId,
      metadata: { page: result.page, limit: result.limit, total: result.total },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('users/:userId/rehearsals')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @RequirePermission(AdminPermission.USER_VIEW)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'List rehearsals by user ID',
    description:
      'Returns paginated rehearsals for a specific actor/reader user. Supports search, filters, and sorting.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description:
      'Search by AI partner details, project/script title, or scene heading',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: 'Rehearsal status',
  })
  @ApiQuery({
    name: 'partnerType',
    required: false,
    type: String,
    description: 'Rehearsal partner type',
  })
  @ApiQuery({
    name: 'projectId',
    required: false,
    type: String,
    description: 'Filter by project ID (UUID)',
  })
  @ApiQuery({
    name: 'sceneId',
    required: false,
    type: String,
    description: 'Filter by scene ID (UUID)',
  })
  @ApiQuery({
    name: 'createdFrom',
    required: false,
    type: String,
    description: 'Created from date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'createdTo',
    required: false,
    type: String,
    description: 'Created to date (YYYY-MM-DD)',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: [
      'createdAt',
      'updatedAt',
      'startedAt',
      'endedAt',
      'sessionDurationSeconds',
    ],
    description: 'Sort field',
  })
  @ApiQuery({
    name: 'sortOrder',
    required: false,
    enum: ['ASC', 'DESC'],
    description: 'Sort order',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiOkResponse({
    description: 'Paginated rehearsals',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: { type: 'string' },
              rehearsalPartnerType: { type: 'string' },
              rehearsalPartnerUserId: {
                type: 'string',
                format: 'uuid',
                nullable: true,
              },
              rehearsalPartnerAiName: { type: 'string', nullable: true },
              partnerDisplayName: {
                type: 'string',
                nullable: true,
                example: 'Reader',
              },
              partner: {
                type: 'object',
                properties: {
                  partnerType: { type: 'string', example: 'USER' },
                  userId: { type: 'string', format: 'uuid', nullable: true },
                  userName: {
                    type: 'string',
                    nullable: true,
                    example: 'Reader',
                  },
                  userEmail: {
                    type: 'string',
                    nullable: true,
                    example: 'reader@example.com',
                  },
                  aiName: { type: 'string', nullable: true, example: 'Hazel' },
                  aiImage: {
                    type: 'string',
                    nullable: true,
                    example: 'https://example.com/ai-character-avatar.jpg',
                  },
                },
              },
              startedAt: {
                type: 'string',
                format: 'date-time',
                nullable: true,
              },
              endedAt: { type: 'string', format: 'date-time', nullable: true },
              sessionDurationSeconds: { type: 'number', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
              projectId: { type: 'string', format: 'uuid' },
              projectTitle: { type: 'string', nullable: true },
              scriptId: { type: 'string', format: 'uuid' },
              scriptTitle: { type: 'string', nullable: true },
              sceneId: { type: 'string', format: 'uuid' },
              sceneNumber: { type: 'number', nullable: true },
              sceneHeading: { type: 'string', nullable: true },
            },
          },
        },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
        totalPages: { type: 'number' },
        hasNext: { type: 'boolean' },
        hasPrev: { type: 'boolean' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Validation error for query params' })
  @ApiNotFoundResponse({ description: 'User not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Requires system_admin or app_admin with user_view permission',
  })
  async listUserRehearsals(
    @Req() req: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query(new ValidationPipe({ transform: true }))
    query: ListUserRehearsalsQueryDto,
  ) {
    const result = await this.adminUsersService.listUserRehearsals(
      userId,
      query,
    );
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_USER_REHEARSALS,
      resourceType: 'user',
      resourceId: userId,
      metadata: { page: result.page, limit: result.limit, total: result.total },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Post('bookings/:id/resolve-no-show')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'Resolve a no-show booking (determine who was absent)',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiNotFoundResponse({
    description: 'Booking not found or not in no_show status',
    schema: {
      example: {
        success: false,
        message: 'Booking not found or not in no_show status',
        statusCode: 404,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with subscription/billing permission',
    schema: {
      example: {
        success: false,
        message:
          'Requires system_admin or app_admin with subscription/billing permission',
        statusCode: 403,
      },
    },
  })
  async resolveNoShow(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
    @Body() dto: ResolveNoShowDto,
  ) {
    const result = await this.sessionLifecycleService.resolveNoShow(
      bookingId,
      dto.noShowBy,
      req.user?.id,
    );

    if (!result) {
      throw new NotFoundException('Booking not found or not in no_show status');
    }

    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_RESOLVE_NO_SHOW,
      resourceType: 'booking',
      resourceId: bookingId,
      metadata: {
        noShowBy: dto.noShowBy,
        resolvedAt: result.resolvedAt,
        resolvedByUserId: result.resolvedByUserId,
        refundExecution: result.refundExecution
          ? {
              action: result.refundExecution.action,
              refundId: result.refundExecution.refundId,
              transferReversalId: result.refundExecution.transferReversalId,
              refundStatus: result.refundExecution.refundStatus,
              reversalStatus: result.refundExecution.reversalStatus,
            }
          : null,
        financialState: result.financialState || null,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });

    return result;
  }

  @Get('bookings/no-shows')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'List all bookings with no_show status pending resolution',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listNoShows(
    @Req() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    const result = await this.bookingService.listNoShowBookings({
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_NO_SHOWS,
      resourceType: 'bookings',
      metadata: {
        page: result.data.page,
        limit: result.data.limit,
        total: result.data.total,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('bookings')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'List marketplace bookings for admin operations',
    description:
      'Paginated booking list with actor/reader context and `financialState` (paymentModel, settlementStatus, refund state).',
  })
  async listBookings(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true }))
    query: ListAdminBookingsQueryDto,
  ) {
    const result = await this.adminBookingsService.listBookings(query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_BOOKINGS,
      resourceType: 'bookings',
      metadata: {
        page: result.data.page,
        limit: result.data.limit,
        total: result.data.total,
        status: query.status ?? null,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('bookings/:id')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({ summary: 'Get booking detail for admin review' })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  async getBookingById(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
  ) {
    const result = await this.adminBookingsService.getBookingById(bookingId);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_GET_BOOKING,
      resourceType: 'booking',
      resourceId: bookingId,
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Post('bookings/:id/complete')
  @Roles(UserRole.SYSTEM_ADMIN, UserRole.APP_ADMIN)
  @UseGuards(RequireSubscriptionOrBillingGuard)
  @ApiOperation({
    summary: 'Manually mark a booking as completed',
    description:
      'Only allowed when booking status is `in_progress` or `confirmed`. Rejects terminal or pre-session states with 400.',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiBadRequestResponse({
    description: 'Booking status does not allow manual completion',
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: {
      example: {
        success: false,
        message: 'Booking not found',
        statusCode: 404,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'Requires system_admin or app_admin with subscription/billing permission',
    schema: {
      example: {
        success: false,
        message:
          'Requires system_admin or app_admin with subscription/billing permission',
        statusCode: 403,
      },
    },
  })
  async completeBooking(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
  ) {
    const result =
      await this.sessionLifecycleService.completeBookingForAdmin(bookingId);

    if (!result) {
      throw new NotFoundException('Booking not found');
    }

    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_COMPLETE_BOOKING,
      resourceType: 'booking',
      resourceId: bookingId,
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });

    return result;
  }

  @Post('user-roles')
  @ApiOperation({
    summary: 'Create a user role (system admin only)',
    description:
      'Creates a new role with a unique code. This action is restricted to system administrators and writes a detailed admin audit log entry.',
  })
  @ApiBody({ type: CreateUserRoleDto })
  @ApiCreatedResponse({
    description: 'Role created successfully',
    schema: {
      example: {
        id: 'b7c531b6-2a71-4627-b8c8-0f2deaf90d2c',
        code: 'support_admin',
        name: 'Support Admin',
        isSystem: false,
        createdAt: '2026-02-21T22:00:00.000Z',
        updatedAt: '2026-02-21T22:00:00.000Z',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation failed or role code already exists',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async createUserRole(@Req() req: any, @Body() dto: CreateUserRoleDto) {
    return this.adminUserRolesService.createRole(dto, req.user?.id, {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
  }

  @Get('user-roles')
  @ApiOperation({
    summary: 'List all user roles',
    description:
      'Returns all roles in ascending code order. Includes system and non-system roles.',
  })
  @ApiOkResponse({
    description: 'List of roles',
    schema: {
      example: [
        {
          id: 'role-uuid-1',
          code: 'actor',
          name: 'Actor',
          isSystem: true,
        },
        {
          id: 'role-uuid-2',
          code: 'support_admin',
          name: 'Support Admin',
          isSystem: false,
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async listUserRoles(@Req() req: any) {
    return this.adminUserRolesService.listRolesWithAudit(false, req.user?.id, {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
  }

  @Get('user-roles/admin')
  @ApiOperation({
    summary: 'List admin roles only',
    description:
      'Returns roles intended for administrative flows (role code contains "admin").',
  })
  @ApiOkResponse({
    description: 'List of admin roles',
    schema: {
      example: [
        {
          id: 'role-uuid-3',
          code: 'system_admin',
          name: 'System Admin',
          isSystem: true,
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async listAdminRoles(@Req() req: any) {
    return this.adminUserRolesService.listRolesWithAudit(true, req.user?.id, {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
  }

  @Get('user-roles/:id')
  @ApiOperation({
    summary: 'Get user role by id',
    description: 'Fetches one role by UUID.',
  })
  @ApiParam({ name: 'id', description: 'Role UUID' })
  @ApiOkResponse({
    description: 'Role found',
    schema: {
      example: {
        id: 'b7c531b6-2a71-4627-b8c8-0f2deaf90d2c',
        code: 'support_admin',
        name: 'Support Admin',
        isSystem: false,
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Role not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async getUserRole(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.adminUserRolesService.getRoleWithAudit(id, req.user?.id, {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
  }

  @Patch('user-roles/:id')
  @ApiOperation({
    summary: 'Update a user role (system admin only)',
    description:
      'Updates role fields (code, name, isSystem). Code must remain unique. A detailed before/after audit log is recorded.',
  })
  @ApiParam({ name: 'id', description: 'Role UUID' })
  @ApiBody({ type: UpdateUserRoleDto })
  @ApiOkResponse({
    description: 'Role updated successfully',
    schema: {
      example: {
        id: 'b7c531b6-2a71-4627-b8c8-0f2deaf90d2c',
        code: 'support_admin',
        name: 'Support Admin Team',
        isSystem: false,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation failed or duplicate role code',
  })
  @ApiNotFoundResponse({ description: 'Role not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async updateUserRole(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ) {
    return this.adminUserRolesService.updateRole(id, dto, req.user?.id, {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
  }

  @Delete('user-roles/:id')
  @ApiOperation({
    summary:
      'Delete a user role only if no users are assigned and role is not system',
    description:
      'Deletes a role when it is non-system and has zero user assignments. Emits a detailed admin audit log entry.',
  })
  @ApiParam({ name: 'id', description: 'Role UUID' })
  @ApiOkResponse({
    description: 'Role deleted successfully',
    schema: {
      example: { success: true, message: 'Role deleted successfully' },
    },
  })
  @ApiBadRequestResponse({
    description: 'Cannot delete system role or role with assigned users',
  })
  @ApiNotFoundResponse({ description: 'Role not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async deleteUserRole(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminUserRolesService.deleteRole(id, req.user?.id, {
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
  }

  @Get('audit-logs')
  @ApiOperation({
    summary: 'List admin audit logs',
    description:
      'Returns paginated admin audit logs with structured metadata for frontend-friendly activity rendering.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Search by summary text',
  })
  @ApiOkResponse({
    description: 'Paginated admin audit logs',
    schema: {
      example: {
        data: [
          {
            id: 'log-uuid-1',
            actorUserId: 'admin-uuid',
            action: 'admin.role.created',
            resourceType: 'user_role',
            resourceId: 'role-uuid-1',
            summary: 'Created role Support Admin (support_admin)',
            metadata: {
              template: 'role_created',
              role: {
                id: 'role-uuid-1',
                code: 'support_admin',
                name: 'Support Admin',
              },
            },
            ipAddress: '::1',
            userAgent: 'Mozilla/5.0',
            createdAt: '2026-02-21T22:22:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Requires system_admin role' })
  async listAuditLogs(
    @Req() req: any,
    @Query(new ValidationPipe({ transform: true }))
    query: ListAuditLogsQueryDto,
  ) {
    const result = await this.adminUserRolesService.listAuditLogs(query);
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_LIST_AUDIT_LOGS,
      resourceType: 'admin_audit_logs',
      metadata: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        search: query.search?.trim() || undefined,
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }

  @Get('queue-health')
  @Roles(UserRole.SYSTEM_ADMIN)
  @UseGuards(PermissionsGuard)
  @ApiOperation({
    summary: 'Get RabbitMQ queue health stats',
    description:
      'Returns real-time queue depth, consumer count, and rates for monitored queues.',
  })
  async getQueueHealth(@Req() req: any) {
    const result = await this.queueMonitorService.getQueueHealthSummary();
    await this.auditService.log({
      userId: req.user?.id,
      action: AuditLogAction.ADMIN_GET_QUEUE_HEALTH,
      resourceType: 'rabbitmq_queues',
      metadata: {
        queueCount: result.length,
        queues: result.map((q) => ({
          name: q.name,
          messages: q.messages,
          consumers: q.consumers,
        })),
      },
      ipAddress: req.ip ?? req.socket?.remoteAddress,
      userAgent: req.get?.('user-agent'),
    });
    return result;
  }
}
