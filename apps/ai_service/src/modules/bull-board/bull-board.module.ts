import { Module } from '@nestjs/common';
import { BullBoardModule as NestBullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import {
  SCRIPT_ANALYSIS_QUEUE,
  SCRIPT_ANALYSIS_HEAVY_QUEUE,
} from '@app/common/bull';

/**
 * Bull Board admin UI — mounted at /admin/queues.
 *
 * Provides visibility into BullMQ jobs: pending, active, completed, failed.
 * Protected by the global JwtAuthGuard; consider adding SYSTEM_ADMIN role guard
 * at the route level for production.
 */
@Module({
  imports: [
    NestBullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    NestBullBoardModule.forFeature({
      name: SCRIPT_ANALYSIS_QUEUE,
      adapter: BullMQAdapter,
    }),
    NestBullBoardModule.forFeature({
      name: SCRIPT_ANALYSIS_HEAVY_QUEUE,
      adapter: BullMQAdapter,
    }),
  ],
})
export class BullBoardModule {}
