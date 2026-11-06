/** biome-ignore-all lint/style/useImportType: <> */

import { PaymentRecord, PaymentRecordStatus } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LessThanOrEqual, DataSource } from 'typeorm';
import { SettlementService } from './settlement.service';

const MAX_PER_TICK = 20;
const MAX_RETRIES = 3;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class SettlementCronService {
  private readonly logger = new Logger(SettlementCronService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settlementService: SettlementService,
  ) {}

  /**
   * Every 5 minutes: process eligible settlements whose dispute window has passed.
   */
  @Cron('*/5 * * * *')
  async processEligibleSettlements() {
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);

    const eligible = await paymentRepo.find({
      where: {
        paymentModel: 'separate',
        settlementStatus: 'eligible',
        status: PaymentRecordStatus.SUCCEEDED,
        settlementEligibleAt: LessThanOrEqual(new Date()),
      },
      take: MAX_PER_TICK,
      order: { settlementEligibleAt: 'ASC' },
    });

    if (eligible.length === 0) return;

    this.logger.log(`Processing ${eligible.length} eligible settlement(s)`);

    let settled = 0;
    let failed = 0;

    for (const payment of eligible) {
      const result = await this.settlementService.settleBooking(
        payment.bookingId,
      );
      if (result.settled) {
        settled++;
      } else {
        failed++;
        this.logger.warn(
          `Settlement failed for booking ${payment.bookingId}: ${result.error}`,
        );
      }
    }

    this.logger.log(
      `Settlement tick complete: ${settled} settled, ${failed} failed`,
    );
  }

  /**
   * Every 4 hours: retry failed settlements (up to MAX_RETRIES).
   */
  @Cron('0 */4 * * *')
  async retryFailedSettlements() {
    const paymentRepo = this.dataSource.getRepository(PaymentRecord);

    const failed = await paymentRepo
      .createQueryBuilder('pr')
      .where('pr.paymentModel = :model', { model: 'separate' })
      .andWhere('pr.settlementStatus = :status', { status: 'failed' })
      .andWhere('pr.status = :paymentStatus', {
        paymentStatus: PaymentRecordStatus.SUCCEEDED,
      })
      .getMany();

    if (failed.length === 0) return;

    const now = Date.now();
    let retried = 0;
    let skipped = 0;

    for (const payment of failed) {
      const meta = payment.settlementMetaData || {};
      const retryCount = meta.retryCount || 0;
      const lastFailedAt = meta.lastFailedAt
        ? new Date(meta.lastFailedAt).getTime()
        : 0;

      // Skip if max retries exceeded
      if (retryCount >= MAX_RETRIES) {
        if (!meta.flaggedForManualReview) {
          payment.settlementMetaData = {
            ...meta,
            flaggedForManualReview: true,
            flaggedAt: new Date().toISOString(),
          };
          await paymentRepo.save(payment);
          this.logger.warn(
            `Booking ${payment.bookingId} flagged for manual review after ${retryCount} failed settlement attempts`,
          );
        }
        skipped++;
        continue;
      }

      // Skip if cooldown hasn't passed
      if (now - lastFailedAt < RETRY_COOLDOWN_MS) {
        skipped++;
        continue;
      }

      const result = await this.settlementService.retrySettlement(
        payment.bookingId,
      );
      if (result.settled) {
        retried++;
      } else {
        skipped++;
      }
    }

    if (retried > 0 || skipped > 0) {
      this.logger.log(
        `Settlement retry: ${retried} retried, ${skipped} skipped`,
      );
    }
  }
}
