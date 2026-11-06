import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

const PREFIX = 'qa:circuit:';
const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_S = 30;

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async getState(service: string): Promise<CircuitState> {
    const openKey = `${PREFIX}${service}:open`;
    const isOpen = await this.redis.get(openKey);
    if (isOpen === 'half_open') return CircuitState.HALF_OPEN;
    if (isOpen) return CircuitState.OPEN;
    return CircuitState.CLOSED;
  }

  async isAvailable(service: string): Promise<boolean> {
    const state = await this.getState(service);
    if (state === CircuitState.CLOSED) return true;
    if (state === CircuitState.HALF_OPEN) return true;
    return false;
  }

  async recordSuccess(service: string): Promise<void> {
    const failKey = `${PREFIX}${service}:failures`;
    const openKey = `${PREFIX}${service}:open`;
    await this.redis.del(failKey, openKey);
  }

  async recordFailure(service: string): Promise<void> {
    const failKey = `${PREFIX}${service}:failures`;
    const openKey = `${PREFIX}${service}:open`;

    const count = await this.redis.incr(failKey);
    await this.redis.expire(failKey, 120);

    if (count >= FAILURE_THRESHOLD) {
      await this.redis.setex(openKey, OPEN_DURATION_S, 'open');
      this.logger.warn(
        `Circuit OPEN for ${service} after ${count} consecutive failures (${OPEN_DURATION_S}s cooldown)`,
      );

      // Schedule half-open state near end of cooldown
      setTimeout(async () => {
        const stillOpen = await this.redis.get(openKey);
        if (stillOpen === 'open') {
          await this.redis.setex(openKey, 10, 'half_open');
          this.logger.log(`Circuit HALF_OPEN for ${service}, allowing probe request`);
        }
      }, (OPEN_DURATION_S - 5) * 1000);
    }
  }
}
