import { CORE_SERVICE, StorageModule } from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { SessionFileAnalysisService } from './session-file-analysis.service';

// Self-contained module so SessionFileAnalysisService can be injected into
// the existing ai_service controller without bloating its provider list.
// StorageModule supplies presigned S3 URLs for the parser job.
// ClientsModule registers the RMQ proxies the service injects directly —
// parent ai_service.module.ts registrations don't propagate into children.
@Module({
  imports: [
    StorageModule,
    ClientsModule.registerAsync([
      {
        name: 'SCRIPT_PARSER_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('SCRIPT_PARSER_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: CORE_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('CORE_SERVICE_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [SessionFileAnalysisService],
  exports: [SessionFileAnalysisService],
})
export class SessionFileAnalysisModule {}
