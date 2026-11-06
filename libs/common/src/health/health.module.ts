import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './database.health';

@Module({
  imports: [TerminusModule, HttpModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator],
  exports: [DatabaseHealthIndicator],
})
export class HealthModule {}
