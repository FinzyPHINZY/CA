// SessionFilesRetentionService — hard-deletes (S3 + DB) shared files that
// have been soft-deleted for longer than the grace period. The grace gives
// participants a window to fetch a file again right after the call ends if
// they forgot to grab it during the session.

import { SessionSharedFileRepository, StorageService } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

const GRACE_HOURS = 24;
const BATCH_SIZE = 100;

@Injectable()
export class SessionFilesRetentionService {
  private readonly logger = new Logger(SessionFilesRetentionService.name);

  constructor(
    private readonly sharedFilesRepo: SessionSharedFileRepository,
    private readonly storageService: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async enforce(): Promise<void> {
    const cutoff = new Date(Date.now() - GRACE_HOURS * 60 * 60 * 1000);

    let totalDeleted = 0;
    let totalErrors = 0;

    // Drain in batches so a backlog doesn't OOM the worker or hold a single
    // long transaction. Cap iterations (10 batches/hour = 1000 rows/hour max)
    // to avoid pathological backlogs starving other cron jobs.
    for (let pass = 0; pass < 10; pass++) {
      const expired = await this.sharedFilesRepo.findExpiredSoftDeleted(
        cutoff,
        BATCH_SIZE,
      );
      if (expired.length === 0) break;

      const idsToHardDelete: string[] = [];
      for (const row of expired) {
        try {
          await this.storageService.deleteObject(row.s3Key);
          idsToHardDelete.push(row.id);
        } catch (err: any) {
          totalErrors++;
          this.logger.warn(
            `Failed to delete S3 object for shared file ${row.id} (key=${row.s3Key}): ${err.message}`,
          );
        }
      }

      if (idsToHardDelete.length > 0) {
        const affected =
          await this.sharedFilesRepo.hardDeleteByIds(idsToHardDelete);
        totalDeleted += affected;
      }

      // Partial batch → backlog drained for this hour, stop early.
      if (expired.length < BATCH_SIZE) break;
    }

    if (totalDeleted > 0 || totalErrors > 0) {
      this.logger.log(
        `Session files retention: deleted=${totalDeleted} errors=${totalErrors} cutoff=${cutoff.toISOString()}`,
      );
    }
  }
}
