import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { SelfTapeController } from './self-tape.controller';
import { SelfTapeService } from './self-tape.service';
import {
  AgoraSession,
  AgoraSessionRepository,
  RecordingRepository,
  Recording,
  MediaModule,
  CdnModule,
  JwtAuthGuard,
  StorageModule,
  AUTH_SERVICE,
} from '@app/common';
import { StudioModule } from '../studio/studio.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AgoraSession, Recording]),
    MediaModule,
    CdnModule,
    StorageModule,
    StudioModule,
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
  controllers: [SelfTapeController],
  providers: [
    SelfTapeService,
    AgoraSessionRepository,
    RecordingRepository,
    JwtAuthGuard,
  ],
  exports: [SelfTapeService],
})
export class SelfTapeModule {}
