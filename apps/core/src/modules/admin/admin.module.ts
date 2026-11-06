import {
  AUTH_SERVICE,
  AuditModule,
  JwtAuthGuard,
  PermissionsGuard,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { ProjectModule } from '../project/project.module';
import { RehearsalModule } from '../rehearsal/rehearsal.module';
import { AdminController } from './admin.controller';
import { AdminContentModerationService } from './admin-content-moderation.service';
import { AdminCronService } from './admin-cron.service';
import { AdminMetricsService } from './admin-metrics.service';
import { HttpMetricsCollectorService } from './http-metrics-collector.service';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { AdminBookingsService } from './admin-bookings.service';
import { AdminProjectsService } from './admin-projects.service';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminSubscriptionsService } from './admin-subscriptions.service';
import { AdminUsersService } from './admin-users.service';
import { AdminUserRolesService } from './admin-user-roles.service';
import { QueueMonitorService } from './queue-monitor.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AuditModule,
    MarketplaceModule,
    ProjectModule,
    RehearsalModule,
    ClientsModule.registerAsync([
      {
        name: AUTH_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.get<string>(
              'AUTH_SERVICE_HOST',
              'auth_service',
            ),
            port: configService.get<number>('AUTH_SERVICE_TCP_PORT', 4001),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [AdminController],
  providers: [
    AdminCronService,
    AdminContentModerationService,
    AdminMetricsService,
    HttpMetricsCollectorService,
    HttpMetricsInterceptor,
    AdminPaymentsService,
    AdminBookingsService,
    AdminProjectsService,
    AdminSubscriptionsService,
    AdminUserRolesService,
    AdminUsersService,
    QueueMonitorService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
})
export class AdminModule {}
