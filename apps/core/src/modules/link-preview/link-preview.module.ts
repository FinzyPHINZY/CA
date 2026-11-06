import { AUTH_SERVICE, JwtAuthGuard } from '@app/common';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { LinkPreviewController } from './link-preview.controller';
import { LinkPreviewService } from './link-preview.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 5000 }),
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
  controllers: [LinkPreviewController],
  providers: [LinkPreviewService, JwtAuthGuard],
})
export class LinkPreviewModule {}
