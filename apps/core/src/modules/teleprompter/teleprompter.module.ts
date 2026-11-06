import {
  AUTH_SERVICE,
  JwtAuthGuard,
  SceneRepository,
  ScriptRepository,
  UserTeleprompterPreference,
  UserTeleprompterPreferenceRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TeleprompterController } from './teleprompter.controller';
import { TeleprompterService } from './teleprompter.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserTeleprompterPreference]),
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
  controllers: [TeleprompterController],
  providers: [
    TeleprompterService,
    UserTeleprompterPreferenceRepository,
    SceneRepository,
    ScriptRepository,
    JwtAuthGuard,
  ],
  exports: [TeleprompterService],
})
export class TeleprompterModule {}
