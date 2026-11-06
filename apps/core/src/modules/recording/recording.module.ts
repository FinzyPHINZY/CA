import {
  AUTH_SERVICE,
  CdnModule,
  JwtAuthGuard,
  MediaModule,
  NOTIFICATIONS_SERVICE,
  ProjectRepository,
  ReaderProfileRepository,
  Recording,
  RecordingRepository,
  RehersalRepository,
  SceneRepository,
  ScriptRepository,
  StorageModule,
  UserRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgoraCloudRecordingService } from '../studio/agora-cloud-recording.service';
import { AgoraTokenService } from '../studio/agora-token.service';
import { SubscriptionModule } from '../subscription/subscription.module';
import { HazelMediaSizeBackfillService } from './hazel-media-size-backfill.service';
import { HazelNcsHandlerService } from './hazel-ncs-handler.service';
import { HazelRecordingConsumer } from './hazel-recording.consumer';
import { HazelRecordingFinalizerService } from './hazel-recording-finalizer.service';
import { HazelRecordingMonitorService } from './hazel-recording-monitor.service';
import { RecordingController } from './recording.controller';
import { RecordingService } from './recording.service';
import { RecordingRetentionService } from './recording-retention.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Recording]),
    MediaModule,
    StorageModule,
    CdnModule,
    SubscriptionModule,
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
        name: NOTIFICATIONS_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('NOTIFICATIONS_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [RecordingController, HazelRecordingConsumer],
  providers: [
    RecordingService,
    RecordingRetentionService,
    RecordingRepository,
    RehersalRepository,
    ProjectRepository,
    SceneRepository,
    ScriptRepository,
    UserRepository,
    ReaderProfileRepository,
    AgoraCloudRecordingService,
    AgoraTokenService,
    HazelRecordingFinalizerService,
    HazelRecordingMonitorService,
    HazelMediaSizeBackfillService,
    HazelNcsHandlerService,
    JwtAuthGuard,
  ],
  exports: [RecordingService, RecordingRepository, HazelNcsHandlerService],
})
export class RecordingModule {}
