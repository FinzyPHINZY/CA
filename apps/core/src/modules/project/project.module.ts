import {
  AI_SERVICE,
  AnalysisOutboxJob,
  AnalysisOutboxJobRepository,
  AUTH_SERVICE,
  BullModule,
  Character,
  CharacterRepository,
  JwtAuthGuard,
  MediaModule,
  Project,
  ProjectRepository,
  RecordingRepository,
  Rehersal,
  RehersalRepository,
  Scene,
  SceneRepository,
  Script,
  ScriptRepository,
  StorageModule,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RehearsalModule } from '../rehearsal/rehearsal.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AnalysisOutboxDispatcherService } from './analysis-outbox-dispatcher.service';
import { ProjectController } from './project.controller';
import { ProjectListService } from './project-list.service';
import { ProjectService } from './project.service';
import { ScriptAnalysisProducerService } from './script-analysis-producer.service';
import { ScriptRecoveryCronService } from './script-recovery-cron.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      Scene,
      Script,
      Character,
      Rehersal,
      AnalysisOutboxJob,
    ]),
    StorageModule,
    RehearsalModule,
    SubscriptionModule,
    BullModule.forRoot(),
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
      {
        name: AI_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672'),
            ],
            queue: configService.get<string>(
              'AI_SERVICE_QUEUE',
              'ai_service.queue',
            ),
          },
        }),
        inject: [ConfigService],
      },
    ]),
    MediaModule,
  ],
  controllers: [ProjectController],
  providers: [
    ProjectService,
    ProjectListService,
    AnalysisOutboxDispatcherService,
    ScriptAnalysisProducerService,
    ScriptRecoveryCronService,
    AnalysisOutboxJobRepository,
    ProjectRepository,
    SceneRepository,
    ScriptRepository,
    CharacterRepository,
    RecordingRepository,
    RehersalRepository,
    JwtAuthGuard,
  ],
  exports: [ProjectService, ProjectListService, ProjectRepository],
})
export class ProjectModule {}
