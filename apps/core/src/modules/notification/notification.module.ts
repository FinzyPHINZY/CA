import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import {
  Notification,
  NotificationRepository,
  ScriptRepository,
  JwtAuthGuard,
  AUTH_SERVICE,
} from '@app/common';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    ConfigModule,
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
    forwardRef(() => AnalysisModule),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationRepository,
    ScriptRepository,
    JwtAuthGuard,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
