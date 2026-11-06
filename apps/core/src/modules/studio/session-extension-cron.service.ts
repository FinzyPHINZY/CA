import { SessionExtensionRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SessionExtensionService } from './session-extension.service';

const READER_APPROVAL_TIMEOUT_SECONDS = 60;
const PAYMENT_WINDOW_SECONDS = 120;

@Injectable()
export class SessionExtensionCronService {
  private readonly logger = new Logger(SessionExtensionCronService.name);

  constructor(
    private readonly sessionExtensionRepository: SessionExtensionRepository,
    private readonly sessionExtensionService: SessionExtensionService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async expireStaleExtensions() {
    // Expire REQUESTED extensions past reader approval timeout
    const expiredRequests =
      await this.sessionExtensionRepository.findExpiredRequests(
        READER_APPROVAL_TIMEOUT_SECONDS,
      );

    for (const ext of expiredRequests) {
      try {
        await this.sessionExtensionService.expireExtension(ext.id);
      } catch (error: any) {
        this.logger.warn(
          `Failed to expire requested extension ${ext.id}: ${error.message}`,
        );
      }
    }

    // Expire PAYMENT_PENDING extensions past payment window
    const expiredPayments =
      await this.sessionExtensionRepository.findExpiredPayments(
        PAYMENT_WINDOW_SECONDS,
      );

    for (const ext of expiredPayments) {
      try {
        await this.sessionExtensionService.expireExtension(ext.id);
      } catch (error: any) {
        this.logger.warn(
          `Failed to expire payment-pending extension ${ext.id}: ${error.message}`,
        );
      }
    }

    const total = expiredRequests.length + expiredPayments.length;
    if (total > 0) {
      this.logger.log(
        `Expired ${total} stale extensions (${expiredRequests.length} requests, ${expiredPayments.length} payments)`,
      );
    }
  }
}
