import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  AI_SERVICE,
  AUTH_SERVICE,
  AuthClientService,
  ScriptRepository,
} from '@app/common';
import { ScriptQaController } from './script-qa.controller';
import { QaRateLimitService } from './services/qa-rate-limit.service';

@Module({
  imports: [
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
  controllers: [ScriptQaController],
  providers: [QaRateLimitService, ScriptRepository, AuthClientService],
})
export class ScriptQaModule {}
