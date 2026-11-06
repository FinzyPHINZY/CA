/** biome-ignore-all lint/style/useImportType: <> */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingService } from '../marketplace/booking/booking.service';
import { SessionLifecycleService } from '../marketplace/booking/session-lifecycle.service';

@Injectable()
export class AdminCronService {
  private readonly logger = new Logger(AdminCronService.name);

  constructor(
    private readonly sessionLifecycleService: SessionLifecycleService,
    private readonly bookingService: BookingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleNoShowDetection() {
    const count = await this.sessionLifecycleService.detectNoShows();
    if (count > 0) {
      this.logger.warn(`Detected ${count} no-show booking(s)`);
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleExpiredHoldCleanup() {
    const count = await this.bookingService.cleanupExpiredHolds();
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} expired held booking(s)`);
    }
  }
}
