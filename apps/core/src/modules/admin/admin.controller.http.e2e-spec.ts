/** biome-ignore-all lint/suspicious/noExplicitAny: HTTP smoke tests */
import {
  Controller,
  Get,
  INestApplication,
  InternalServerErrorException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import {
  AuditService,
  JwtAuthGuard,
  PermissionsGuard,
  RequireSubscriptionOrBillingGuard,
  RolesGuard,
  UsageRecord,
  User,
} from '@app/common';
import { AdminController } from './admin.controller';
import { AdminContentModerationService } from './admin-content-moderation.service';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminProjectsService } from './admin-projects.service';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { AdminUserRolesService } from './admin-user-roles.service';
import { AdminUsersService } from './admin-users.service';
import { AdminBookingsService } from './admin-bookings.service';
import { BookingService } from '../marketplace/booking/booking.service';
import { SessionLifecycleService } from '../marketplace/booking/session-lifecycle.service';
import { ProjectListService } from '../project/project-list.service';
import { ProjectService } from '../project/project.service';
import { HttpMetricsCollectorService } from './http-metrics-collector.service';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { QueueMonitorService } from './queue-monitor.service';
import { AdminContentType } from './dto/delete-content.dto';

/** Used to exercise HTTP metrics aggregation (platform latency / error rate). */
@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { ok: true };
  }

  @Get('error')
  err() {
    throw new InternalServerErrorException('forced error');
  }
}

const bookingUuid = '11111111-1111-4111-a111-111111111111';
const projectUuid = '22222222-2222-4222-a222-222222222222';
const userUuid = '33333333-3333-4333-a333-333333333333';
const contentUuid = '44444444-4444-4444-a444-444444444444';
const roleUuid = '55555555-5555-4555-a555-555555555555';

function emptyPaginated(page = 1, limit = 20) {
  return {
    data: [] as any[],
    total: 0,
    page,
    limit,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
  };
}

describe('AdminController HTTP smoke (all routes)', () => {
  let app: INestApplication;

  let adminUsersService: any;
  let adminProjectsService: any;
  let adminSubscriptionsService: any;
  let adminPaymentsService: any;
  let adminContentModerationService: any;
  let sessionLifecycleService: any;
  let bookingService: any;
  let adminUserRolesService: any;
  let projectListService: any;
  let queueMonitorService: any;

  beforeAll(async () => {
    const userRepoQb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        totalSignups: '98',
        activeUsers: '190',
      }),
    };
    const projectRepoQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(121),
    };

    const usageRepoQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        geminiCurSum: '1250000',
        geminiCurCnt: '24',
        geminiPrevSum: '800000',
        geminiPrevCnt: '18',
        elevenCurSum: '50000',
        elevenCurCnt: '10',
        elevenPrevSum: '30000',
        elevenPrevCnt: '6',
      }),
    };

    const dataSourceMock = {
      getRepository: jest.fn().mockImplementation((entity: any) => ({
        createQueryBuilder: jest
          .fn()
          .mockReturnValue(
            entity === UsageRecord || entity?.name === 'UsageRecord'
              ? usageRepoQb
              : entity === User || entity?.name === 'User'
                ? userRepoQb
                : entity?.name === 'Project'
                  ? projectRepoQb
                  : userRepoQb,
          ),
      })),
    };

    adminUsersService = {
      listUsers: jest.fn().mockResolvedValue(emptyPaginated()),
      getSingleUser: jest.fn().mockResolvedValue({
        id: userUuid,
        email: 'user@example.com',
        name: 'Test User',
        accountType: 'actor',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastLoginAt: null,
        disabled: false,
        userStatus: 'active',
        subscriptionStatus: 'inactive',
        recordingsCount: 0,
        rehearsalsCount: 0,
        subscription: null,
      }),
      listUserRecordings: jest.fn().mockResolvedValue(emptyPaginated()),
      listUserRehearsals: jest.fn().mockResolvedValue(emptyPaginated()),
    };

    adminProjectsService = {
      listProjects: jest.fn().mockResolvedValue(emptyPaginated()),
      flagProject: jest.fn().mockResolvedValue({
        message: 'Project flagged successfully',
        projectId: projectUuid,
        isFlagged: true,
        latestFlag: {
          id: 'flag-1',
          status: 'PENDING',
          reason: null,
          flaggedAt: new Date().toISOString(),
          flaggedBy: { userId: null, name: null, email: null },
        },
      }),
    };

    adminSubscriptionsService = {
      listSubscriptions: jest.fn().mockResolvedValue(emptyPaginated()),
    };

    adminPaymentsService = {
      getPaymentsSummary: jest.fn().mockResolvedValue({
        totalActiveSubs: 1,
        totalActiveSubsChange: 0,
        mrr: 100,
        mrrChange: 0,
        refundsTotal: 0,
        failedPaymentsCount: 0,
      }),
      listPaymentReconciliationIssues: jest.fn().mockResolvedValue({
        success: true,
        message: 'ok',
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 20,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      }),
      retryBookingRefund: jest.fn().mockResolvedValue({
        refundId: 're_1',
        transferReversalId: 'trr_1',
        refundStatus: 'succeeded',
        reversalStatus: 'pending_webhook',
      }),
    };

    adminContentModerationService = {
      deleteContent: jest.fn().mockResolvedValue({
        message: 'Content deleted successfully',
        contentId: contentUuid,
        contentType: 'script',
        deletedAt: new Date().toISOString(),
        cleanup: { detachedRelations: 0, deletedOrphanMediaCount: 0 },
      }),
    };

    sessionLifecycleService = {
      resolveNoShow: jest.fn().mockResolvedValue({
        noShowBy: 'reader',
        resolvedAt: new Date(),
        resolvedByUserId: 'admin-id',
        refundExecution: null,
        financialState: null,
      }),
      completeBooking: jest.fn().mockResolvedValue({
        bookingId: bookingUuid,
        status: 'completed',
      }),
      completeBookingForAdmin: jest.fn().mockResolvedValue({
        id: bookingUuid,
        status: 'completed',
      }),
    };

    bookingService = {
      listNoShowBookings: jest.fn().mockResolvedValue({
        data: {
          page: 1,
          limit: 20,
          total: 0,
          bookings: [],
        },
      }),
    };

    adminUserRolesService = {
      createRole: jest.fn().mockResolvedValue({
        id: roleUuid,
        code: 'support_admin',
        name: 'Support Admin',
        isSystem: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      listRolesWithAudit: jest
        .fn()
        .mockResolvedValue([
          { id: roleUuid, code: 'actor', name: 'Actor', isSystem: true },
        ]),
      getRoleWithAudit: jest.fn().mockResolvedValue({
        id: roleUuid,
        code: 'support_admin',
        name: 'Support Admin',
        isSystem: false,
      }),
      updateRole: jest.fn().mockResolvedValue({
        id: roleUuid,
        code: 'support_admin',
        name: 'Renamed',
        isSystem: false,
      }),
      deleteRole: jest.fn().mockResolvedValue({
        success: true,
        message: 'Role deleted successfully',
      }),
      listAuditLogs: jest.fn().mockResolvedValue({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      }),
    };

    projectListService = {
      listByUserId: jest.fn().mockResolvedValue(emptyPaginated()),
    };

    queueMonitorService = {
      getQueueHealthSummary: jest.fn().mockResolvedValue([
        {
          name: 'ai_service.queue',
          messages: 0,
          consumers: 1,
          publishRate: 0,
          deliverRate: 0,
        },
      ]),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AdminController, ProbeController],
      providers: [
        AdminMetricsService,
        HttpMetricsCollectorService,
        HttpMetricsInterceptor,
        { provide: DataSource, useValue: dataSourceMock },
        { provide: BookingService, useValue: bookingService },
        { provide: SessionLifecycleService, useValue: sessionLifecycleService },
        {
          provide: AdminContentModerationService,
          useValue: adminContentModerationService,
        },
        { provide: AdminPaymentsService, useValue: adminPaymentsService },
        { provide: AdminProjectsService, useValue: adminProjectsService },
        {
          provide: AdminSubscriptionsService,
          useValue: adminSubscriptionsService,
        },
        { provide: AdminUsersService, useValue: adminUsersService },
        { provide: AdminUserRolesService, useValue: adminUserRolesService },
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ProjectListService, useValue: projectListService },
        {
          provide: ProjectService,
          useValue: {
            getProjectOutboxJobsForAdmin: jest.fn(),
            retryProjectScriptAnalysisForAdmin: jest.fn(),
          },
        },
        {
          provide: AdminBookingsService,
          useValue: {
            listBookings: jest.fn().mockResolvedValue({
              success: true,
              data: { items: [], total: 0, page: 1, limit: 20 },
            }),
            getBookingById: jest.fn(),
          },
        },
        { provide: QueueMonitorService, useValue: queueMonitorService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RequireSubscriptionOrBillingGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    app.useGlobalInterceptors(app.get(HttpMetricsInterceptor));
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /admin/metrics/users', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/users')
      .query({
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-06T23:59:59.999Z',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      totalSignups: 98,
      activeUsers: 190,
    });
  });

  it('GET /admin/metrics/platform (invalid window)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/platform')
      .query({
        from: '2026-05-06T23:59:59.999Z',
        to: '2026-05-01T00:00:00.000Z',
      })
      .expect(400);
    expect(String(res.body?.message || '')).toContain('from');
  });

  it('GET /admin/metrics/platform (with probe traffic)', async () => {
    await request(app.getHttpServer()).get('/probe/ok').expect(200);
    await request(app.getHttpServer()).get('/probe/error').expect(500);
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/platform')
      .query({
        from: '2000-01-01T00:00:00.000Z',
        to: '2100-01-01T00:00:00.000Z',
      })
      .expect(200);
    expect(res.body.projectsCreated).toBe(121);
    expect(res.body.avgLatencySeconds).not.toBeNull();
    expect(res.body.errorRatePercentage).toBeGreaterThan(0);
  });

  it('GET /admin/metrics/tokens', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/tokens')
      .query({
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-06T23:59:59.999Z',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      geminiTokenTotal: 1_250_000,
      geminiUsageRecordCount: 24,
      elevenLabsCharacterTotal: 50_000,
      elevenLabsUsageRecordCount: 10,
      geminiTokenPreviousTotal: 800_000,
      geminiTokenDelta: 450_000,
      elevenLabsCharacterPreviousTotal: 30_000,
      elevenLabsCharacterDelta: 20_000,
    });
    expect(res.body).toHaveProperty('from');
    expect(res.body).toHaveProperty('to');
    expect(res.body).toHaveProperty('previousFrom');
    expect(res.body).toHaveProperty('previousTo');
    expect(res.body.geminiEstimatedCostUsd).toBeNull();
  });

  it('GET /admin/metrics/tokens (default window — no query)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/tokens')
      .expect(200);
    expect(res.body).toMatchObject({
      geminiTokenTotal: 1_250_000,
      geminiUsageRecordCount: 24,
    });
  });

  it('GET /admin/metrics/tokens (invalid window)', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/metrics/tokens')
      .query({
        from: '2026-05-06T23:59:59.999Z',
        to: '2026-05-01T00:00:00.000Z',
      })
      .expect(400);
    expect(String(res.body?.message || '')).toContain('from');
  });

  it('GET /admin/users', async () => {
    await request(app.getHttpServer()).get('/admin/users').expect(200);
    expect(adminUsersService.listUsers).toHaveBeenCalled();
  });

  it('GET /admin/projects', async () => {
    await request(app.getHttpServer()).get('/admin/projects').expect(200);
    expect(adminProjectsService.listProjects).toHaveBeenCalled();
  });

  it('GET /admin/subscriptions', async () => {
    await request(app.getHttpServer()).get('/admin/subscriptions').expect(200);
    expect(adminSubscriptionsService.listSubscriptions).toHaveBeenCalled();
  });

  it('GET /admin/payments/summary', async () => {
    await request(app.getHttpServer())
      .get('/admin/payments/summary')
      .expect(200);
    expect(adminPaymentsService.getPaymentsSummary).toHaveBeenCalled();
  });

  it('GET /admin/payments/reconciliation-issues', async () => {
    await request(app.getHttpServer())
      .get('/admin/payments/reconciliation-issues')
      .expect(200);
    expect(
      adminPaymentsService.listPaymentReconciliationIssues,
    ).toHaveBeenCalled();
  });

  it('POST /admin/bookings/:id/refund-retry', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/bookings/${bookingUuid}/refund-retry`)
      .expect(201);
    expect(res.body.success).toBe(true);
    expect(adminPaymentsService.retryBookingRefund).toHaveBeenCalledWith(
      bookingUuid,
    );
  });

  it('POST /admin/projects/:projectId/flag', async () => {
    await request(app.getHttpServer())
      .post(`/admin/projects/${projectUuid}/flag`)
      .send({ reason: 'test' })
      .expect(201);
    expect(adminProjectsService.flagProject).toHaveBeenCalled();
  });

  it('POST /admin/content/:contentId/delete', async () => {
    await request(app.getHttpServer())
      .post(`/admin/content/${contentUuid}/delete`)
      .send({ contentType: AdminContentType.SCRIPT })
      .expect(201);
    expect(adminContentModerationService.deleteContent).toHaveBeenCalled();
  });

  it('GET /admin/users/:userId', async () => {
    await request(app.getHttpServer())
      .get(`/admin/users/${userUuid}`)
      .expect(200);
    expect(adminUsersService.getSingleUser).toHaveBeenCalledWith(userUuid);
  });

  it('GET /admin/users/:userId/projects', async () => {
    await request(app.getHttpServer())
      .get(`/admin/users/${userUuid}/projects`)
      .expect(200);
    expect(projectListService.listByUserId).toHaveBeenCalled();
  });

  it('GET /admin/users/:userId/recordings', async () => {
    await request(app.getHttpServer())
      .get(`/admin/users/${userUuid}/recordings`)
      .expect(200);
    expect(adminUsersService.listUserRecordings).toHaveBeenCalled();
  });

  it('GET /admin/users/:userId/rehearsals', async () => {
    await request(app.getHttpServer())
      .get(`/admin/users/${userUuid}/rehearsals`)
      .expect(200);
    expect(adminUsersService.listUserRehearsals).toHaveBeenCalled();
  });

  it('POST /admin/bookings/:id/resolve-no-show', async () => {
    await request(app.getHttpServer())
      .post(`/admin/bookings/${bookingUuid}/resolve-no-show`)
      .send({ noShowBy: 'reader' })
      .expect(201);
    expect(sessionLifecycleService.resolveNoShow).toHaveBeenCalled();
  });

  it('GET /admin/bookings/no-shows', async () => {
    await request(app.getHttpServer())
      .get('/admin/bookings/no-shows')
      .expect(200);
    expect(bookingService.listNoShowBookings).toHaveBeenCalled();
  });

  it('POST /admin/bookings/:id/complete', async () => {
    await request(app.getHttpServer())
      .post(`/admin/bookings/${bookingUuid}/complete`)
      .expect(201);
    expect(sessionLifecycleService.completeBookingForAdmin).toHaveBeenCalledWith(
      bookingUuid,
    );
  });

  it('POST /admin/user-roles', async () => {
    await request(app.getHttpServer())
      .post('/admin/user-roles')
      .send({ code: 'support_admin', name: 'Support Admin' })
      .expect(201);
    expect(adminUserRolesService.createRole).toHaveBeenCalled();
  });

  it('GET /admin/user-roles', async () => {
    await request(app.getHttpServer()).get('/admin/user-roles').expect(200);
    expect(adminUserRolesService.listRolesWithAudit).toHaveBeenCalledWith(
      false,
      undefined,
      expect.any(Object),
    );
  });

  it('GET /admin/user-roles/admin', async () => {
    await request(app.getHttpServer())
      .get('/admin/user-roles/admin')
      .expect(200);
    expect(adminUserRolesService.listRolesWithAudit).toHaveBeenCalledWith(
      true,
      undefined,
      expect.any(Object),
    );
  });

  it('GET /admin/user-roles/:id', async () => {
    await request(app.getHttpServer())
      .get(`/admin/user-roles/${roleUuid}`)
      .expect(200);
    expect(adminUserRolesService.getRoleWithAudit).toHaveBeenCalled();
  });

  it('PATCH /admin/user-roles/:id', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/user-roles/${roleUuid}`)
      .send({ name: 'Renamed' })
      .expect(200);
    expect(adminUserRolesService.updateRole).toHaveBeenCalled();
  });

  it('DELETE /admin/user-roles/:id', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/user-roles/${roleUuid}`)
      .expect(200);
    expect(adminUserRolesService.deleteRole).toHaveBeenCalled();
  });

  it('GET /admin/audit-logs', async () => {
    await request(app.getHttpServer()).get('/admin/audit-logs').expect(200);
    expect(adminUserRolesService.listAuditLogs).toHaveBeenCalled();
  });

  it('GET /admin/queue-health', async () => {
    await request(app.getHttpServer()).get('/admin/queue-health').expect(200);
    expect(queueMonitorService.getQueueHealthSummary).toHaveBeenCalled();
  });
});
