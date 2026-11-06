import {
  DatabaseModule,
  HealthModule,
  LoggerModule,
  NOTIFICATIONS_SERVICE,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import * as Joi from 'joi';
import { AuthModule } from './auth/auth.module';
import { AuthServiceController } from './auth_service.controller';
import { Auth_Service } from './auth_service.service';
import { InternalController } from './internal.controller';
import { InternalUserController } from './internal-user.controller';
import { UsersModule } from './users/users.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        RABBITMQ_URL: Joi.string().default('amqp://rabbitmq:5672'),
        NOTIFICATIONS_QUEUE: Joi.string().default('notifications.queue'),
        AUTH_SERVICE_TCP_PORT: Joi.number().default(4001),
        GOOGLE_CLIENT_ID: Joi.string().optional(),
        GOOGLE_CLIENT_SECRET: Joi.string().optional(),
        APPLE_CLIENT_ID: Joi.string().optional(),
        APPLE_CLIENT_SECRET: Joi.string().optional(),
        APPLE_TEAM_ID: Joi.string().optional(),
        APPLE_KEY_ID: Joi.string().optional(),
        APPLE_PRIVATE_KEY: Joi.string().optional(),
        APPLE_REDIRECT_URI: Joi.string().optional(),
        JWT_SECRET: Joi.string().default('your-secret-key'),
        JWT_REFRESH_SECRET: Joi.string().default('refresh-secret'),
        JWT_ACCESS_TOKEN_EXPIRES_IN: Joi.string().default('15m'),
        JWT_REFRESH_TOKEN_EXPIRES_IN: Joi.string().default('7d'),
      }),
    }),
    LoggerModule,
    DatabaseModule,
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672'),
            ],
            queue: configService.get<string>(
              'NOTIFICATIONS_QUEUE',
              'notifications.queue',
            ),
            queueOptions: {
              durable: true,
            },
            socketOptions: {
              heartbeatIntervalInSeconds: 60,
              reconnectTimeInSeconds: 5,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
    UsersModule,
    AuthModule,
    HealthModule,
  ],
  controllers: [
    AuthServiceController,
    InternalController,
    InternalUserController,
  ],
  providers: [Auth_Service],
})
export class AuthServiceModule {}
