import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailTemplateService } from './services/email-template.service';
import { EmailService } from './services/email.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule, User } from '@app/common';
import { LoggerModule } from '@app/common';
import { HealthModule } from '@app/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification, NotificationRepository } from '@app/common';
import { NotificationQueueService } from '../websocket/notification-queue.service';
import { WebSocketModule } from '../websocket/websocket.module';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CORE_SERVICE } from '@app/common';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    HealthModule,
    TypeOrmModule.forFeature([Notification, User]),
    WebSocketModule,
    ClientsModule.registerAsync([
      {
        name: CORE_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>(
              'CORE_SERVICE_QUEUE',
              'core_service.queue',
            ),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationRepository,
    EmailTemplateService,
    EmailService,
  ],
  exports: [
    NotificationsService,
    NotificationRepository,
    EmailTemplateService,
    EmailService,
  ],
})
export class NotificationsModule {}
