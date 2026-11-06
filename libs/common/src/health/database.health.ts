import { Injectable, Optional } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';

@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  constructor(
    @Optional()
    @InjectConnection()
    private readonly connection?: Connection,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // If no database connection is available, skip the check
    if (!this.connection) {
      return this.getStatus(key, true, { message: 'Database not configured' });
    }

    try {
      await this.connection.query('SELECT 1');
      return this.getStatus(key, true);
    } catch (error) {
      throw new HealthCheckError(
        'Database check failed',
        this.getStatus(key, false, { message: error.message }),
      );
    }
  }
}
