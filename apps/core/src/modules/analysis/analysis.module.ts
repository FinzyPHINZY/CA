import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AnalysisResultHandlerService } from './analysis-result-handler.service';
import { ScriptAnalysisRepository } from './repositories/script-analysis.repository';
import { ScriptAnalysis } from './entities/script-analysis.entity';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AI_SERVICE,
  NOTIFICATIONS_SERVICE,
  AUTH_SERVICE,
  ProjectRepository,
  ScriptRepository,
  CharacterRepository,
} from '@app/common';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ScriptAnalysis]),
    ClientsModule.registerAsync([
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
      {
        name: NOTIFICATIONS_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('NOTIFICATIONS_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
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
  controllers: [AnalysisController, AnalysisResultHandlerService],
  providers: [
    AnalysisService,
    AnalysisResultHandlerService,
    ScriptAnalysisRepository,
    ProjectRepository,
    ScriptRepository,
    CharacterRepository,
  ],
  exports: [AnalysisService, ScriptAnalysisRepository],
})
export class AnalysisModule {}
