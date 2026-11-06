import {
  ActorReview,
  AgoraSession,
  AdminAuditLog,
  AI_SERVICE,
  AnalysisOutboxJob,
  AuditLog,
  Availability,
  Booking,
  Character,
  DatabaseModule,
  FavoriteReader,
  FeedbackRequest,
  Genre,
  HealthModule,
  LoggerModule,
  Media,
  NOTIFICATIONS_SERVICE,
  Notification,
  Permission,
  PaymentRecord,
  Project,
  ProjectFlagged,
  ReaderCalendarConnection,
  ReaderProfile,
  ReaderReview,
  ReaderSessionRate,
  ReaderSocialLink,
  ReaderSpecialty,
  ReaderWorkSample,
  Recording,
  RedisModule,
  RehearsalEvent,
  RehearsalReview,
  Rehersal,
  Scene,
  Script,
  ScriptMaterial,
  SessionExtension,
  SessionSharedFile,
  TimeSlot,
  UsageRecord,
  User,
  UserRoleEntity,
  UserTeleprompterPreference,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import * as Joi from 'joi';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';
import { DomainEventHandlerController } from './domain-event-handler.controller';
import { InternalController } from './internal.controller';
import { AdminModule } from './modules/admin/admin.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { LinkPreviewModule } from './modules/link-preview/link-preview.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { ScriptAnalysis } from './modules/analysis/entities/script-analysis.entity';
import { AvailabilityModule } from './modules/availability/availability.module';
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationModule } from './modules/notification/notification.module';
import { PaymentModule } from './modules/payment/payment.module';
import { ProjectModule } from './modules/project/project.module';
import { RecordingModule } from './modules/recording/recording.module';
import { RehearsalModule } from './modules/rehearsal/rehearsal.module';
import { SceneModule } from './modules/scene/scene.module';
import { ScriptModule } from './modules/script/script.module';
import { SelfTapeModule } from './modules/self-tape/self-tape.module';
import { StudioModule } from './modules/studio/studio.module';
import { SubscriptionModule } from './modules/subscription/subscription.module';
import { ScriptQaModule } from './modules/script-qa/script-qa.module';
import { TeleprompterModule } from './modules/teleprompter/teleprompter.module';
import { TranscodeModule } from './modules/transcode/transcode.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        CORE_PORT: Joi.number().default(3000),
        RABBITMQ_URL: Joi.string().default('amqp://rabbitmq:5672'),
        AI_SERVICE_QUEUE: Joi.string().default('ai_service.queue'),
        CORE_SERVICE_QUEUE: Joi.string().default('core_service.queue'),
        DOMAIN_EVENTS_QUEUE: Joi.string().default('domain.events.queue'),
        AUTH_SERVICE_HOST: Joi.string().default('auth_service'),
        AUTH_SERVICE_TCP_PORT: Joi.number().default(4001),
        REDIS_URL: Joi.string().default('redis://localhost:6379'),
        STRIPE_WEBHOOK_SECRET: Joi.string().allow('').optional(),
        STRIPE_CONNECT_WEBHOOK_SECRET: Joi.string().allow('').optional(),
        WEBHOOK_SECRET: Joi.string().allow('').optional(),
        AGORA_APP_ID: Joi.string().required(),
        AGORA_APP_CERTIFICATE: Joi.string().required(),
        AGORA_CUSTOMER_KEY: Joi.string().required(),
        AGORA_CUSTOMER_SECRET: Joi.string().required(),
        MEDIACONVERT_ENDPOINT: Joi.string().allow('').optional(),
        MEDIACONVERT_ROLE_ARN: Joi.string().allow('').optional(),
        CLOUDFRONT_DOMAIN: Joi.string().allow('').optional(),
        CLOUDFRONT_KEY_PAIR_ID: Joi.string().allow('').optional(),
        CLOUDFRONT_PRIVATE_KEY: Joi.string().allow('').optional(),
        // Calendar integration (C.0)
        CALENDAR_ENCRYPTION_KEY: Joi.string().allow('').optional(),
        GOOGLE_CALENDAR_CLIENT_ID: Joi.string().allow('').optional(),
        GOOGLE_CALENDAR_CLIENT_SECRET: Joi.string().allow('').optional(),
        GOOGLE_CALENDAR_REDIRECT_URI: Joi.string().allow('').optional(),
        MICROSOFT_CALENDAR_CLIENT_ID: Joi.string().allow('').optional(),
        MICROSOFT_CALENDAR_CLIENT_SECRET: Joi.string().allow('').optional(),
        MICROSOFT_CALENDAR_TENANT_ID: Joi.string().allow('').optional(),
        MICROSOFT_CALENDAR_REDIRECT_URI: Joi.string().allow('').optional(),
        USE_BULLMQ_DISPATCH: Joi.boolean().default(false),
      }),
    }),
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('NOTIFICATIONS_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: AI_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('AI_SERVICE_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
    DatabaseModule.forRoot({
      entities: [
        User,
        UserRoleEntity,
        Permission,
        AdminAuditLog,
        AuditLog,
        Genre,
        Availability,
        TimeSlot,
        AnalysisOutboxJob,
        Project,
        ProjectFlagged,
        Media,
        Script,
        Scene,
        Character,
        Recording,
        Rehersal,
        ScriptAnalysis,
        Notification,
        ReaderProfile,
        ReaderSessionRate,
        ReaderSpecialty,
        ReaderWorkSample,
        ReaderSocialLink,
        ReaderCalendarConnection,
        ReaderReview,
        ActorReview,
        FeedbackRequest,
        Booking,
        PaymentRecord,
        FavoriteReader,
        RehearsalEvent,
        RehearsalReview,
        AgoraSession,
        UsageRecord,
        UserTeleprompterPreference,
        ScriptMaterial,
        SessionExtension,
        SessionSharedFile,
      ],
    }),
    LoggerModule,
    RedisModule.forRoot(),
    HealthModule,
    MediaModule,
    SubscriptionModule,
    PaymentModule,
    TranscodeModule,
    AvailabilityModule,
    ProjectModule,
    AnalysisModule,
    RecordingModule,
    ScriptModule,
    SceneModule,
    RehearsalModule,
    NotificationModule,
    MarketplaceModule,
    CalendarModule,
    SelfTapeModule,
    StudioModule,
    TeleprompterModule,
    ScriptQaModule,
    AdminModule,
    LinkPreviewModule,
    MaterialsModule,
  ],
  controllers: [
    CoreController,
    DomainEventHandlerController,
    InternalController,
  ],
  providers: [CoreService],
})
export class CoreModule {}
