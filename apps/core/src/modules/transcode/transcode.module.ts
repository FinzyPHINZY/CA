import {
  AUTH_SERVICE,
  MediaModule as CommonMediaModule,
  JwtAuthGuard,
  Recording,
  RecordingRepository,
  StorageModule,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TranscodeController } from './transcode.controller';
import { TranscodeService } from './transcode.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Recording]),
    CommonMediaModule,
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
    ]),
  ],
  controllers: [TranscodeController],
  providers: [TranscodeService, RecordingRepository, JwtAuthGuard],
  exports: [TranscodeService],
})
export class TranscodeModule {}
