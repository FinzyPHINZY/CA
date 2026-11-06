import {
  AgoraSession,
  AgoraSessionRepository,
  AI_SERVICE,
  AUTH_SERVICE,
  Booking,
  BookingRepository,
  JwtAuthGuard,
  MediaModule,
  NOTIFICATIONS_SERVICE,
  PaymentRecord,
  ReaderProfile,
  ReaderSessionRate,
  RecordingRepository,
  Rehersal,
  RehersalRepository,
  SessionExtension,
  SessionExtensionRepository,
  SessionSharedFile,
  SessionSharedFileRepository,
  StorageModule,
  TimeSlot,
  UsageRecordRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { RecordingModule } from '../recording/recording.module';
import { RehearsalModule } from '../rehearsal/rehearsal.module';
import { AgoraChannelService } from './agora-channel.service';
import { AgoraCloudRecordingService } from './agora-cloud-recording.service';
import { AgoraTokenService } from './agora-token.service';
import { BookingSessionBridgeService } from './booking-session-bridge.service';
import { SessionExtensionCronService } from './session-extension-cron.service';
import { SessionExtensionService } from './session-extension.service';
import { SessionChatService } from './session-chat.service';
import { SessionFilesConsumer } from './session-files.consumer';
import { SessionFilesController } from './session-files.controller';
import { SessionFilesRetentionService } from './session-files-retention.service';
import { SessionFilesService } from './session-files.service';
import { SessionService } from './session.service';
import { StudioController } from './studio.controller';
import { StudioRecordingService } from './studio-recording.service';
import { StudioRecordingMonitorService } from './studio-recording-monitor.service';

@Module({
  imports: [
    MarketplaceModule,
    RehearsalModule,
    RecordingModule,
    TypeOrmModule.forFeature([
      AgoraSession,
      Booking,
      PaymentRecord,
      ReaderProfile,
      ReaderSessionRate,
      Rehersal,
      SessionExtension,
      SessionSharedFile,
      TimeSlot,
    ]),
    MediaModule,
    StorageModule,
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
      {
        name: AI_SERVICE,
        imports: [ConfigModule],
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
  ],
  controllers: [StudioController, SessionFilesController, SessionFilesConsumer],
  providers: [
    AgoraTokenService,
    AgoraChannelService,
    AgoraCloudRecordingService,
    StudioRecordingService,
    StudioRecordingMonitorService,
    SessionChatService,
    SessionFilesRetentionService,
    SessionFilesService,
    SessionService,
    SessionExtensionService,
    SessionExtensionCronService,
    BookingSessionBridgeService,
    AgoraSessionRepository,
    BookingRepository,
    RehersalRepository,
    SessionExtensionRepository,
    SessionSharedFileRepository,
    RecordingRepository,
    UsageRecordRepository,
    JwtAuthGuard,
  ],
  exports: [
    AgoraTokenService,
    AgoraChannelService,
    AgoraCloudRecordingService,
    StudioRecordingService,
    SessionFilesService,
    SessionService,
    SessionExtensionService,
  ],
})
export class StudioModule {}
