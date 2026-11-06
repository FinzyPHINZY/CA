import { DynamicModule, Module } from '@nestjs/common';
import { BullModule as NestBullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  SCRIPT_ANALYSIS_QUEUE,
  SCRIPT_ANALYSIS_HEAVY_QUEUE,
} from './script-analysis-job.interface';

/**
 * Shared BullMQ module — registers Redis connection + both analysis queues.
 *
 * Import in core (producer) and ai_service (consumer).
 * Uses the same REDIS_URL already used by the rest of the platform.
 */
@Module({})
export class BullModule {
  static forRoot(): DynamicModule {
    return {
      module: BullModule,
      imports: [
        NestBullModule.forRootAsync({
          imports: [ConfigModule],
          useFactory: (configService: ConfigService) => ({
            connection: {
              url: configService.get<string>(
                'REDIS_URL',
                'redis://localhost:6379',
              ),
            },
            defaultJobOptions: {
              removeOnComplete: { count: 500 },
              removeOnFail: { count: 1000 },
              attempts: 3,
              backoff: { type: 'exponential', delay: 30_000 },
            },
          }),
          inject: [ConfigService],
        }),
        NestBullModule.registerQueue(
          { name: SCRIPT_ANALYSIS_QUEUE },
          { name: SCRIPT_ANALYSIS_HEAVY_QUEUE },
        ),
      ],
      exports: [NestBullModule],
    };
  }
}
