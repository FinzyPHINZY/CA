import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as Joi from 'joi';
import { FileServiceController } from './file_service.controller';
import { FileServiceService } from './file_service.service';
import {
  StorageModule,
  MediaModule,
  DatabaseModule,
  LoggerModule,
  HealthModule,
  Media,
} from '@app/common';
import { AUTH_SERVICE, JwtAuthGuard } from '@app/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        FILE_SERVICE_PORT: Joi.number().default(3004),
        AUTH_SERVICE_HOST: Joi.string().default('auth_service'),
        AUTH_SERVICE_TCP_PORT: Joi.number().default(4001),
        AWS_REGION: Joi.string().default('us-east-1'),
        AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
        AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
        AWS_S3_BUCKET: Joi.string().allow('').optional(),
      }),
    }),
    DatabaseModule.forRoot({
      entities: [Media],
    }),
    LoggerModule,
    HealthModule,
    StorageModule,
    MediaModule,
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
  controllers: [FileServiceController],
  providers: [FileServiceService, JwtAuthGuard],
})
export class FileServiceModule {}
