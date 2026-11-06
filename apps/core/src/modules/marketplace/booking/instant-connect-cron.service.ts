import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InstantConnectService } from './instant-connect.service';

@Injectable()
export class InstantConnectCronService {
  private readonly logger = new Logger(InstantConnectCronService.name);

  constructor(private readonly instantConnectService: InstantConnectService) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async cleanupExpiredInstantRequests() {
    try {
      const cancelled =
        await this.instantConnectService.cleanupExpiredRequests();
      if (cancelled > 0) {
        this.logger.log(
          `Cleaned up ${cancelled} expired instant connect request(s)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to cleanup expired instant connect requests: ${error.message}`,
        error.stack,
      );
    }
  }
}
