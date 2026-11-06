import { Module } from '@nestjs/common';
import { NotificationsServiceController } from './notifications_service.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DatabaseModule } from '@app/common';
import { LoggerModule } from '@app/common';
import { HealthModule } from '@app/common';
import { RedisModule } from '@app/common';
import { Booking, Notification } from '@app/common';
import { User, UserRoleEntity, Genre, Permission } from '@app/common';
import { NotificationsModule } from './notifications/notifications.module';
import { WebSocketModule } from './websocket/websocket.module';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        NOTIFICATIONS_SERVICE_PORT: Joi.number().default(3003),
        NOTIFICATIONS_TCP_PORT: Joi.number().default(4004),
        RABBITMQ_URL: Joi.string().default('amqp://rabbitmq:5672'),
        NOTIFICATIONS_QUEUE: Joi.string().default('notifications.queue'),
        EMAIL_ENABLED: Joi.boolean().default(false),
        EMAIL_HOST: Joi.string().optional(),
        EMAIL_PORT: Joi.number().optional(),
        EMAIL_USER: Joi.string().optional(),
        EMAIL_PASSWORD: Joi.string().optional(),
        EMAIL_SECURE: Joi.boolean().optional(),
        EMAIL_FROM: Joi.string().optional(),
        EMAIL_FROM_NAME: Joi.string().optional(),
        EMAIL_FROM_ADDRESS: Joi.string().optional(),
        SMTP_HOST: Joi.string().optional(),
        SMTP_PORT: Joi.number().optional(),
        SMTP_USER: Joi.string().optional(),
        SMTP_PASSWORD: Joi.string().optional(),
        SMTP_SECURE: Joi.boolean().optional(),
        SMTP_SERVICE: Joi.string().optional(),
        REDIS_URL: Joi.string().default('redis://localhost:6379'),
      }),
    }),
    LoggerModule,
    RedisModule.forRoot(),
    DatabaseModule.forRoot({
      entities: [
        Booking,
        Notification,
        User,
        UserRoleEntity,
        Permission,
        Genre,
      ],
    }),
    HealthModule,
    NotificationsModule,
    WebSocketModule,
  ],
  controllers: [NotificationsServiceController],
})
export class NotificationsServiceModule {}
