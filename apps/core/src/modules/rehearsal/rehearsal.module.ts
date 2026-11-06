import {
  AUTH_SERVICE,
  AuthClientService,
  CharacterRepository,
  JwtAuthGuard,
  ProjectRepository,
  RehearsalEvent,
  RehearsalReview,
  Rehersal,
  RehersalRepository,
  SceneRepository,
  ScriptRepository,
  UserRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RehearsalController } from './rehearsal.controller';
import { BookedRehearsalService } from './booked-rehearsal.service';
import { RehearsalReviewService } from './rehearsal-review.service';
import { RehearsalListService } from './rehearsal-list.service';
import { RehearsalLifecycleEventService } from './rehearsal-lifecycle-event.service';
import { RehearsalReadModelService } from './rehearsal-read-model.service';
import { RehearsalService } from './rehearsal.service';
import { RehearsalAnalyticsService } from './rehearsal-analytics.service';
import { RehearsalAnalyticsCronService } from './rehearsal-analytics-cron.service';
import { RehearsalSettingsService } from './rehearsal-settings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Rehersal, RehearsalEvent, RehearsalReview]),
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
  controllers: [RehearsalController],
  providers: [
    RehearsalService,
    BookedRehearsalService,
    RehearsalListService,
    RehearsalLifecycleEventService,
    RehearsalReadModelService,
    RehearsalAnalyticsService,
    RehearsalAnalyticsCronService,
    RehearsalSettingsService,
    AuthClientService,
    RehearsalReviewService,
    RehersalRepository,
    ProjectRepository,
    ScriptRepository,
    SceneRepository,
    CharacterRepository,
    UserRepository,
    JwtAuthGuard,
  ],
  exports: [
    RehearsalService,
    BookedRehearsalService,
    RehearsalListService,
    RehearsalLifecycleEventService,
    RehearsalReadModelService,
    RehersalRepository,
    RehearsalAnalyticsService,
    RehearsalSettingsService,
    RehearsalReviewService,
  ],
})
export class RehearsalModule {}
