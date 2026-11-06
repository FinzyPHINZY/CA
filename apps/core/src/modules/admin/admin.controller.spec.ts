/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { AuditLogAction, AuditService, UserRole } from '@app/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BookingService } from '../marketplace/booking/booking.service';
import { SessionLifecycleService } from '../marketplace/booking/session-lifecycle.service';
import { ProjectListService } from '../project/project-list.service';
import { ProjectService } from '../project/project.service';
import { AdminBookingsService } from './admin-bookings.service';
import { AdminContentModerationService } from './admin-content-moderation.service';
import { AdminMetricsService } from './admin-metrics.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminProjectsService } from './admin-projects.service';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { AdminUserRolesService } from './admin-user-roles.service';
import { AdminUsersService } from './admin-users.service';
import { AdminController } from './admin.controller';
import { AdminContentType, DeleteContentDto } from './dto/delete-content.dto';
import { FlagProjectDto } from './dto/flag-project.dto';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { ListSubscriptionsQueryDto } from './dto/list-subscriptions-query.dto';
import {
  ListUserRecordingsQueryDto,
  ListUserRehearsalsQueryDto,
  ListUsersQueryDto,
} from './dto/list-users-query.dto';
import { ResolveNoShowDto } from './dto/resolve-no-show.dto';
import { ListProjectsByUserIdQueryDto } from '../project/dto/list-projects-by-user-query.dto';
import { QueueMonitorService } from './queue-monitor.service';

describe('AdminController', () => {
  let controller: AdminController;

  let sessionLifecycleService: jest.Mocked<
    Pick<
      SessionLifecycleService,
      'resolveNoShow' | 'completeBooking' | 'completeBookingForAdmin'
    >
  >;
  let bookingService: jest.Mocked<Pick<BookingService, 'listNoShowBookings'>>;
  let adminContentModerationService: jest.Mocked<
    Pick<AdminContentModerationService, 'deleteContent'>
  >;
  let adminPaymentsService: jest.Mocked<
    Pick<
      AdminPaymentsService,
      | 'getPaymentsSummary'
      | 'listPaymentReconciliationIssues'
      | 'listSettlementIssues'
      | 'listFinancialReconciliationIssues'
      | 'retryBookingRefund'
      | 'retryBookingSettlement'
    >
  >;
  let adminMetricsService: jest.Mocked<
    Pick<
      AdminMetricsService,
      | 'getUserMetrics'
      | 'getPlatformMetrics'
      | 'getTokenMetrics'
      | 'getExtendedUsageMetrics'
    >
  >;
  let adminBookingsService: jest.Mocked<
    Pick<AdminBookingsService, 'listBookings' | 'getBookingById'>
  >;
  let projectService: jest.Mocked<
    Pick<
      ProjectService,
      'getProjectOutboxJobsForAdmin' | 'retryProjectScriptAnalysisForAdmin'
    >
  >;
  let adminProjectsService: jest.Mocked<
    Pick<
      AdminProjectsService,
      'listProjects' | 'listProjectsEnriched' | 'flagProject'
    >
  >;
  let adminSubscriptionsService: jest.Mocked<
    Pick<AdminSubscriptionsService, 'listSubscriptions'>
  >;
  let adminUsersService: jest.Mocked<
    Pick<
      AdminUsersService,
      | 'listUsers'
      | 'getSingleUser'
      | 'listUserRecordings'
      | 'listUserRehearsals'
    >
  >;
  let adminUserRolesService: jest.Mocked<
    Pick<
      AdminUserRolesService,
      | 'createRole'
      | 'listRolesWithAudit'
      | 'getRoleWithAudit'
      | 'updateRole'
      | 'deleteRole'
      | 'listAuditLogs'
    >
  >;
  let auditService: jest.Mocked<Pick<AuditService, 'log'>>;
  let projectListService: jest.Mocked<Pick<ProjectListService, 'listByUserId'>>;
  let queueMonitorService: jest.Mocked<
    Pick<QueueMonitorService, 'getQueueHealthSummary'>
  >;

  const adminUserId = 'admin-user-uuid';
  const bookingUuid = 'b0000000-0000-4000-8000-000000000001';
  const projectUuid = 'p0000000-0000-4000-8000-000000000002';
  const userUuid = 'u0000000-0000-4000-8000-000000000003';
  const contentUuid = 'c0000000-0000-4000-8000-000000000004';
  const roleUuid = 'r0000000-0000-4000-8000-000000000005';

  function mockReq(overrides: Partial<any> = {}) {
    return {
      user: { id: adminUserId, role: UserRole.SYSTEM_ADMIN },
      ip: '127.0.0.1',
      get: jest.fn().mockReturnValue('jest-agent'),
      socket: { remoteAddress: '::1' },
      ...overrides,
    };
  }

  beforeEach(() => {
    sessionLifecycleService = {
      resolveNoShow: jest.fn(),
      completeBooking: jest.fn(),
      completeBookingForAdmin: jest.fn(),
    };
    bookingService = {
      listNoShowBookings: jest.fn(),
    };
    adminContentModerationService = {
      deleteContent: jest.fn(),
    };
    adminPaymentsService = {
      getPaymentsSummary: jest.fn(),
      listPaymentReconciliationIssues: jest.fn(),
      listSettlementIssues: jest.fn(),
      listFinancialReconciliationIssues: jest.fn(),
      retryBookingRefund: jest.fn(),
      retryBookingSettlement: jest.fn(),
    };
    adminMetricsService = {
      getUserMetrics: jest.fn(),
      getPlatformMetrics: jest.fn(),
      getTokenMetrics: jest.fn(),
      getExtendedUsageMetrics: jest.fn(),
    };
    adminProjectsService = {
      listProjects: jest.fn(),
      listProjectsEnriched: jest.fn(),
      flagProject: jest.fn(),
    };
    adminBookingsService = {
      listBookings: jest.fn(),
      getBookingById: jest.fn(),
    };
    projectService = {
      getProjectOutboxJobsForAdmin: jest.fn(),
      retryProjectScriptAnalysisForAdmin: jest.fn(),
    };
    adminSubscriptionsService = {
      listSubscriptions: jest.fn(),
    };
    adminUsersService = {
      listUsers: jest.fn(),
      getSingleUser: jest.fn(),
      listUserRecordings: jest.fn(),
      listUserRehearsals: jest.fn(),
    };
    adminUserRolesService = {
      createRole: jest.fn(),
      listRolesWithAudit: jest.fn(),
      getRoleWithAudit: jest.fn(),
      updateRole: jest.fn(),
      deleteRole: jest.fn(),
      listAuditLogs: jest.fn(),
    };
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    projectListService = {
      listByUserId: jest.fn(),
    };
    queueMonitorService = {
      getQueueHealthSummary: jest.fn(),
    };

    controller = new AdminController(
      sessionLifecycleService as unknown as SessionLifecycleService,
      bookingService as unknown as BookingService,
      adminContentModerationService as unknown as AdminContentModerationService,
      adminMetricsService as unknown as AdminMetricsService,
      adminPaymentsService as unknown as AdminPaymentsService,
      adminProjectsService as unknown as AdminProjectsService,
      adminSubscriptionsService as unknown as AdminSubscriptionsService,
      adminUsersService as unknown as AdminUsersService,
      adminUserRolesService as unknown as AdminUserRolesService,
      auditService as unknown as AuditService,
      projectListService as unknown as ProjectListService,
      projectService as unknown as ProjectService,
      adminBookingsService as unknown as AdminBookingsService,
      queueMonitorService as unknown as QueueMonitorService,
    );
  });

  describe('GET /admin/metrics/users', () => {
    it('returns user metrics from service', async () => {
      const query = {
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-06T23:59:59.999Z',
      };
      const svc = {
        totalSignups: 98,
        activeUsers: 190,
        from: query.from,
        to: query.to,
      };
      adminMetricsService.getUserMetrics.mockResolvedValue(svc as any);

      const result = await controller.getUserMetrics(query as any);

      expect(adminMetricsService.getUserMetrics).toHaveBeenCalledWith(query);
      expect(result).toEqual(svc);
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/metrics/tokens', () => {
    it('returns token metrics from service', async () => {
      const query = {
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-06T23:59:59.999Z',
      };
      const svc = {
        geminiTokenTotal: 1_500_000,
        geminiUsageRecordCount: 42,
        elevenLabsCharacterTotal: 0,
        elevenLabsUsageRecordCount: 0,
        previousFrom: '2026-04-24T00:00:00.000Z',
        previousTo: '2026-04-30T23:59:59.999Z',
        geminiTokenPreviousTotal: 1_000_000,
        geminiTokenDelta: 500_000,
        geminiUsageRecordCountPrevious: 30,
        geminiUsageRecordCountDelta: 12,
        elevenLabsCharacterPreviousTotal: 0,
        elevenLabsCharacterDelta: 0,
        elevenLabsUsageRecordCountPrevious: 0,
        elevenLabsUsageRecordCountDelta: 0,
        geminiEstimatedCostUsd: null,
        geminiEstimatedCostPreviousUsd: null,
        geminiEstimatedCostDeltaUsd: null,
        elevenLabsEstimatedCostUsd: null,
        elevenLabsEstimatedCostPreviousUsd: null,
        elevenLabsEstimatedCostDeltaUsd: null,
        totalEstimatedCostUsd: null,
        totalEstimatedCostPreviousUsd: null,
        totalEstimatedCostDeltaUsd: null,
        from: query.from,
        to: query.to,
      };
      adminMetricsService.getTokenMetrics.mockResolvedValue(svc as any);

      const result = await controller.getTokenMetrics(query as any);

      expect(adminMetricsService.getTokenMetrics).toHaveBeenCalledWith(query);
      expect(result).toEqual(svc);
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException from service for invalid window', async () => {
      const query = {
        from: '2026-05-06T23:59:59.999Z',
        to: '2026-05-01T00:00:00.000Z',
      };
      adminMetricsService.getTokenMetrics.mockRejectedValue(
        new BadRequestException('"from" must be earlier than or equal to "to"'),
      );

      await expect(
        controller.getTokenMetrics(query as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(adminMetricsService.getTokenMetrics).toHaveBeenCalledWith(query);
    });
  });

  describe('GET /admin/metrics/platform', () => {
    it('returns platform metrics from service', async () => {
      const query = {
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-06T23:59:59.999Z',
      };
      const svc = {
        projectsCreated: 121,
        uptimePercentage: 92.5,
        avgLatencySeconds: 1.3,
        errorRatePercentage: 1.3,
        from: query.from,
        to: query.to,
      };
      adminMetricsService.getPlatformMetrics.mockResolvedValue(svc as any);

      const result = await controller.getPlatformMetrics(query as any);

      expect(adminMetricsService.getPlatformMetrics).toHaveBeenCalledWith(
        query,
      );
      expect(result).toEqual(svc);
      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/users', () => {
    it('lists users, returns service result, and writes audit log', async () => {
      const query = {
        page: 1,
        limit: 20,
        search: 'jane',
      } as ListUsersQueryDto;
      const svc = {
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      adminUsersService.listUsers.mockResolvedValue(svc as any);

      const req = mockReq();
      const result = await controller.listUsers(req, query);

      expect(adminUsersService.listUsers).toHaveBeenCalledWith(query);
      expect(result).toBe(svc);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: adminUserId,
          action: AuditLogAction.ADMIN_LIST_USERS,
          resourceType: 'users',
          metadata: { page: 1, limit: 20, total: 0 },
        }),
      );
    });
  });

  describe('GET /admin/projects', () => {
    it('lists projects and audits with pagination metadata', async () => {
      const query = {
        page: 2,
        limit: 10,
        tab: 'flagged',
      } as ListProjectsQueryDto;
      const svc = {
        data: [],
        total: 3,
        page: 2,
        limit: 10,
        totalPages: 1,
        hasNext: false,
        hasPrev: true,
      };
      adminProjectsService.listProjects.mockResolvedValue(svc as any);

      const result = await controller.listProjects(mockReq(), query);

      expect(adminProjectsService.listProjects).toHaveBeenCalledWith(query);
      expect(result).toBe(svc);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_PROJECTS,
          metadata: { page: 2, limit: 10, total: 3 },
        }),
      );
    });
  });

  describe('GET /admin/subscriptions', () => {
    it('lists subscriptions and audits', async () => {
      const query = { plan: 'PREMIUM' } as ListSubscriptionsQueryDto;
      const svc = {
        data: [],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      };
      adminSubscriptionsService.listSubscriptions.mockResolvedValue(svc as any);

      const result = await controller.listSubscriptions(mockReq(), query);

      expect(adminSubscriptionsService.listSubscriptions).toHaveBeenCalledWith(
        query,
      );
      expect(result).toBe(svc);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_SUBSCRIPTIONS,
          resourceType: 'subscriptions',
        }),
      );
    });
  });

  describe('GET /admin/payments/summary', () => {
    it('returns payments summary and audits metric snapshot', async () => {
      const summary = {
        totalActiveSubs: 10,
        totalActiveSubsChange: 1,
        mrr: 5000,
        mrrChange: 100,
        refundsTotal: 200,
        failedPaymentsCount: 0,
      };
      adminPaymentsService.getPaymentsSummary.mockResolvedValue(summary as any);

      const result = await controller.getPaymentsSummary(mockReq());

      expect(adminPaymentsService.getPaymentsSummary).toHaveBeenCalled();
      expect(result).toEqual(summary);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_GET_PAYMENTS_SUMMARY,
          metadata: expect.objectContaining({
            totalActiveSubs: 10,
            mrr: 5000,
            failedPaymentsCount: 0,
          }),
        }),
      );
    });
  });

  describe('GET /admin/payments/reconciliation-issues', () => {
    it('passes page and limit to service and audits', async () => {
      const payload = {
        data: { page: 2, limit: 15, total: 4, items: [] },
      };
      adminPaymentsService.listPaymentReconciliationIssues.mockResolvedValue(
        payload as any,
      );

      const result = await controller.listPaymentReconciliationIssues(
        mockReq(),
        2,
        15,
      );

      expect(
        adminPaymentsService.listPaymentReconciliationIssues,
      ).toHaveBeenCalledWith({ page: 2, limit: 15 });
      expect(result).toBe(payload);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_PAYMENT_RECONCILIATION_ISSUES,
          metadata: {
            page: 2,
            limit: 15,
            total: 4,
          },
        }),
      );
    });

    it('defaults page=1 and limit=20 when omitted', async () => {
      const payload = {
        data: { page: 1, limit: 20, total: 0, items: [] },
      };
      adminPaymentsService.listPaymentReconciliationIssues.mockResolvedValue(
        payload as any,
      );

      await controller.listPaymentReconciliationIssues(mockReq());

      expect(
        adminPaymentsService.listPaymentReconciliationIssues,
      ).toHaveBeenCalledWith({ page: 1, limit: 20 });
    });
  });

  describe('POST /admin/bookings/:id/refund-retry', () => {
    it('retries refund, wraps payload, and audits refund ids', async () => {
      const refundResult = {
        refundId: 're_1',
        transferReversalId: 'trr_1',
        refundStatus: 'succeeded',
        reversalStatus: 'pending_webhook',
      };
      adminPaymentsService.retryBookingRefund.mockResolvedValue(
        refundResult as any,
      );

      const out = await controller.retryBookingRefund(mockReq(), bookingUuid);

      expect(adminPaymentsService.retryBookingRefund).toHaveBeenCalledWith(
        bookingUuid,
      );
      expect(out).toEqual({
        success: true,
        message: 'Booking refund retry processed',
        data: refundResult,
      });
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_RETRY_BOOKING_REFUND,
          resourceId: bookingUuid,
          metadata: expect.objectContaining({
            refundId: 're_1',
            transferReversalId: 'trr_1',
          }),
        }),
      );
    });
  });

  describe('POST /admin/projects/:projectId/flag', () => {
    it('flags project with admin user id and reason, then audits', async () => {
      const dto: FlagProjectDto = { reason: 'policy violation here' };
      const flagResult = {
        message: 'ok',
        projectId: projectUuid,
        isFlagged: true,
        latestFlag: { id: 'flag-1', status: 'PENDING' },
      };
      adminProjectsService.flagProject.mockResolvedValue(flagResult as any);

      const result = await controller.flagProject(mockReq(), projectUuid, dto);

      expect(adminProjectsService.flagProject).toHaveBeenCalledWith(
        projectUuid,
        adminUserId,
        'policy violation here',
      );
      expect(result).toBe(flagResult);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_FLAG_PROJECT,
          resourceId: projectUuid,
          metadata: { reason: 'policy violation here', isFlagged: true },
        }),
      );
    });
  });

  describe('POST /admin/content/:contentId/delete', () => {
    it('deletes content by type and audits cleanup summary', async () => {
      const dto: DeleteContentDto = { contentType: AdminContentType.SCRIPT };
      const delResult = {
        message: 'Content deleted successfully',
        contentId: contentUuid,
        contentType: 'script',
        deletedAt: new Date().toISOString(),
        cleanup: { detachedRelations: 2, deletedOrphanMediaCount: 0 },
      };
      adminContentModerationService.deleteContent.mockResolvedValue(
        delResult as any,
      );

      const result = await controller.deleteContent(
        mockReq(),
        contentUuid,
        dto,
      );

      expect(adminContentModerationService.deleteContent).toHaveBeenCalledWith(
        contentUuid,
        AdminContentType.SCRIPT,
      );
      expect(result).toBe(delResult);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_DELETE_CONTENT,
          resourceType: 'script',
          resourceId: contentUuid,
        }),
      );
    });
  });

  describe('GET /admin/users/:userId', () => {
    it('returns user detail and audits resource id', async () => {
      const userDetail = { id: userUuid, email: 'a@b.com' };
      adminUsersService.getSingleUser.mockResolvedValue(userDetail as any);

      const result = await controller.getSingleUser(mockReq(), userUuid);

      expect(adminUsersService.getSingleUser).toHaveBeenCalledWith(userUuid);
      expect(result).toBe(userDetail);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_GET_USER,
          resourceType: 'user',
          resourceId: userUuid,
        }),
      );
    });
  });

  describe('GET /admin/users/:userId/projects', () => {
    it('delegates to ProjectListService.listByUserId with query', async () => {
      const query = {
        page: 1,
        limit: 5,
        search: 'draft',
      } as ListProjectsByUserIdQueryDto;
      const page = {
        data: [],
        total: 0,
        page: 1,
        limit: 5,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      projectListService.listByUserId.mockResolvedValue(page as any);

      const result = await controller.listUserProjects(
        mockReq(),
        userUuid,
        query,
      );

      expect(projectListService.listByUserId).toHaveBeenCalledWith(
        userUuid,
        query,
      );
      expect(result).toBe(page);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_USER_PROJECTS,
          resourceId: userUuid,
        }),
      );
    });
  });

  describe('GET /admin/users/:userId/recordings', () => {
    it('lists recordings for user with filters', async () => {
      const query = {
        page: 1,
        sortBy: 'createdAt',
        sortOrder: 'DESC',
      } as ListUserRecordingsQueryDto;
      const page = {
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      };
      adminUsersService.listUserRecordings.mockResolvedValue(page as any);

      const result = await controller.listUserRecordings(
        mockReq(),
        userUuid,
        query,
      );

      expect(adminUsersService.listUserRecordings).toHaveBeenCalledWith(
        userUuid,
        query,
      );
      expect(result).toBe(page);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_USER_RECORDINGS,
        }),
      );
    });
  });

  describe('GET /admin/users/:userId/rehearsals', () => {
    it('lists rehearsals for user', async () => {
      const query = { page: 2, limit: 10 } as ListUserRehearsalsQueryDto;
      const page = {
        data: [],
        total: 0,
        page: 2,
        limit: 10,
        totalPages: 0,
        hasNext: false,
        hasPrev: true,
      };
      adminUsersService.listUserRehearsals.mockResolvedValue(page as any);

      const result = await controller.listUserRehearsals(
        mockReq(),
        userUuid,
        query,
      );

      expect(adminUsersService.listUserRehearsals).toHaveBeenCalledWith(
        userUuid,
        query,
      );
      expect(result).toBe(page);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_USER_REHEARSALS,
        }),
      );
    });
  });

  describe('POST /admin/bookings/:id/resolve-no-show', () => {
    it('returns lifecycle result and audits resolution metadata', async () => {
      const dto: ResolveNoShowDto = { noShowBy: 'reader' };
      const resolved = {
        noShowBy: 'reader',
        resolvedAt: new Date(),
        resolvedByUserId: adminUserId,
        refundExecution: null,
        financialState: null,
      };
      sessionLifecycleService.resolveNoShow.mockResolvedValue(resolved as any);

      const result = await controller.resolveNoShow(
        mockReq(),
        bookingUuid,
        dto,
      );

      expect(sessionLifecycleService.resolveNoShow).toHaveBeenCalledWith(
        bookingUuid,
        'reader',
        adminUserId,
      );
      expect(result).toBe(resolved);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_RESOLVE_NO_SHOW,
          resourceId: bookingUuid,
        }),
      );
    });

    it('throws NotFoundException when booking is not no_show / missing', async () => {
      sessionLifecycleService.resolveNoShow.mockResolvedValue(null as any);

      await expect(
        controller.resolveNoShow(mockReq(), bookingUuid, {
          noShowBy: 'actor',
        }),
      ).rejects.toThrow(NotFoundException);

      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('GET /admin/bookings/no-shows', () => {
    it('lists no-shows with pagination defaults and audits', async () => {
      const list = {
        data: {
          page: 1,
          limit: 20,
          total: 1,
          bookings: [],
        },
      };
      bookingService.listNoShowBookings.mockResolvedValue(list as any);

      const result = await controller.listNoShows(mockReq());

      expect(bookingService.listNoShowBookings).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
      });
      expect(result).toBe(list);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_NO_SHOWS,
        }),
      );
    });
  });

  describe('POST /admin/bookings/:id/complete', () => {
    it('returns completion payload and audits', async () => {
      const done = { bookingId: bookingUuid, status: 'completed' };
      sessionLifecycleService.completeBookingForAdmin.mockResolvedValue(
        done as any,
      );

      const result = await controller.completeBooking(mockReq(), bookingUuid);

      expect(
        sessionLifecycleService.completeBookingForAdmin,
      ).toHaveBeenCalledWith(bookingUuid);
      expect(result).toBe(done);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_COMPLETE_BOOKING,
          resourceId: bookingUuid,
        }),
      );
    });

    it('throws NotFoundException when booking missing', async () => {
      sessionLifecycleService.completeBookingForAdmin.mockResolvedValue(
        null as any,
      );

      await expect(
        controller.completeBooking(mockReq(), bookingUuid),
      ).rejects.toThrow(NotFoundException);

      expect(auditService.log).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/user-roles', () => {
    it('creates role via AdminUserRolesService with audit context', async () => {
      const dto = { code: 'support_admin', name: 'Support Admin' };
      const created = { id: roleUuid, ...dto, isSystem: false };
      adminUserRolesService.createRole.mockResolvedValue(created as any);

      const result = await controller.createUserRole(mockReq(), dto as any);

      expect(adminUserRolesService.createRole).toHaveBeenCalledWith(
        dto,
        adminUserId,
        expect.objectContaining({
          ipAddress: '127.0.0.1',
          userAgent: 'jest-agent',
        }),
      );
      expect(result).toBe(created);
    });
  });

  describe('GET /admin/user-roles', () => {
    it('lists all roles (adminOnly=false)', async () => {
      const roles = [{ id: '1', code: 'actor', isSystem: true }];
      adminUserRolesService.listRolesWithAudit.mockResolvedValue(roles as any);

      const result = await controller.listUserRoles(mockReq());

      expect(adminUserRolesService.listRolesWithAudit).toHaveBeenCalledWith(
        false,
        adminUserId,
        expect.any(Object),
      );
      expect(result).toBe(roles);
    });
  });

  describe('GET /admin/user-roles/admin', () => {
    it('lists admin roles only', async () => {
      const roles = [{ id: '2', code: 'system_admin', isSystem: true }];
      adminUserRolesService.listRolesWithAudit.mockResolvedValue(roles as any);

      const result = await controller.listAdminRoles(mockReq());

      expect(adminUserRolesService.listRolesWithAudit).toHaveBeenCalledWith(
        true,
        adminUserId,
        expect.any(Object),
      );
      expect(result).toBe(roles);
    });
  });

  describe('GET /admin/user-roles/:id', () => {
    it('fetches single role', async () => {
      const role = { id: roleUuid, code: 'x', name: 'Y' };
      adminUserRolesService.getRoleWithAudit.mockResolvedValue(role as any);

      const result = await controller.getUserRole(mockReq(), roleUuid);

      expect(adminUserRolesService.getRoleWithAudit).toHaveBeenCalledWith(
        roleUuid,
        adminUserId,
        expect.any(Object),
      );
      expect(result).toBe(role);
    });
  });

  describe('PATCH /admin/user-roles/:id', () => {
    it('updates role', async () => {
      const dto = { name: 'Renamed' };
      const updated = { id: roleUuid, code: 'x', name: 'Renamed' };
      adminUserRolesService.updateRole.mockResolvedValue(updated as any);

      const result = await controller.updateUserRole(
        mockReq(),
        roleUuid,
        dto as any,
      );

      expect(adminUserRolesService.updateRole).toHaveBeenCalledWith(
        roleUuid,
        dto,
        adminUserId,
        expect.any(Object),
      );
      expect(result).toBe(updated);
    });
  });

  describe('DELETE /admin/user-roles/:id', () => {
    it('deletes role', async () => {
      const out = { success: true, message: 'Role deleted successfully' };
      adminUserRolesService.deleteRole.mockResolvedValue(out as any);

      const result = await controller.deleteUserRole(mockReq(), roleUuid);

      expect(adminUserRolesService.deleteRole).toHaveBeenCalledWith(
        roleUuid,
        adminUserId,
        expect.any(Object),
      );
      expect(result).toBe(out);
    });
  });

  describe('GET /admin/audit-logs', () => {
    it('lists audit logs and writes follow-up audit entry', async () => {
      const query = {
        page: 1,
        limit: 20,
        search: 'role',
      } as ListAuditLogsQueryDto;
      const page = {
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      };
      adminUserRolesService.listAuditLogs.mockResolvedValue(page as any);

      const result = await controller.listAuditLogs(mockReq(), query);

      expect(adminUserRolesService.listAuditLogs).toHaveBeenCalledWith(query);
      expect(result).toBe(page);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_LIST_AUDIT_LOGS,
          metadata: expect.objectContaining({
            page: 1,
            search: 'role',
          }),
        }),
      );
    });
  });

  describe('GET /admin/queue-health', () => {
    it('returns queue summary and audits queue names', async () => {
      const health = [
        {
          name: 'q1',
          messages: 0,
          consumers: 1,
          publishRate: 0,
          deliverRate: 0,
        },
      ];
      queueMonitorService.getQueueHealthSummary.mockResolvedValue(
        health as any,
      );

      const result = await controller.getQueueHealth(mockReq());

      expect(queueMonitorService.getQueueHealthSummary).toHaveBeenCalled();
      expect(result).toBe(health);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditLogAction.ADMIN_GET_QUEUE_HEALTH,
          metadata: expect.objectContaining({
            queueCount: 1,
            queues: [{ name: 'q1', messages: 0, consumers: 1 }],
          }),
        }),
      );
    });
  });
});
