import { Controller, Get, Optional, Inject } from '@nestjs/common';
import {
  HealthCheckService,
  HealthCheck,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { DatabaseHealthIndicator } from './database.health';
import { Public } from '../auth/public.decorator';

@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    @Optional()
    private readonly database?: DatabaseHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Check the health status of the service' })
  @ApiOkResponse({ description: 'Service health status' })
  check() {
    const checks = [
      // Memory health check - warn if using more than 1.5GB
      () => this.memory.checkHeap('memory_heap', 1500 * 1024 * 1024),
      // Memory RSS health check - warn if using more than 1.5GB
      () => this.memory.checkRSS('memory_rss', 1500 * 1024 * 1024),
      // Disk health check - warn if using more than 80% of disk space
      () =>
        this.disk.checkStorage('disk', {
          path: '/',
          thresholdPercent: 0.8,
        }),
    ];

    // Only add database check if database is configured
    if (this.database) {
      checks.unshift(() => this.database.isHealthy('database'));
    }

    return this.health.check(checks);
  }

  @Get('liveness')
  @ApiOperation({ summary: 'Liveness probe for Kubernetes' })
  @ApiOkResponse({ description: 'Service is alive' })
  liveness() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('readiness')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe for Kubernetes' })
  @ApiOkResponse({ description: 'Service is ready' })
  readiness() {
    const checks = [];

    // Only add database check if database is configured
    if (this.database) {
      checks.push(() => this.database.isHealthy('database'));
    }

    // If no checks, just return a simple status
    if (checks.length === 0) {
      return {
        status: 'ok',
        info: {
          service: {
            status: 'up',
          },
        },
        timestamp: new Date().toISOString(),
      };
    }

    return this.health.check(checks);
  }
}
