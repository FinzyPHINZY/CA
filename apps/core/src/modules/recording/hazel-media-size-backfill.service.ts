// Backfills the actual S3 object size for Media rows attached to Hazel
/** biome-ignore-all lint/style/useImportType: <> */
// recordings. Agora uploads the recording file asynchronously after /stop, so
// at finalize time we create Media with size=0 and rely on this cron to fill
// the real ContentLength once the upload lands.
//
// Scope is intentionally narrowed to Hazel (RecordingTypeEnum.AI_PARTNER) so we
// do not interfere with other media creation paths (transcode, self-tape) that
// already populate size at write time. Bound to a 24h window after creation —
// anything older is left alone (S3 lookups for objects that never uploaded
// would just keep failing).

import {
  MediaRepository,
  RecordingTypeEnum,
  StorageService,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

// per-tick cap so a backlog of unprocessed media doesn't blow up a single
// cron tick with hundreds of S3 HeadObject calls.
const BACKFILL_BATCH_SIZE = 50;

@Injectable()
export class HazelMediaSizeBackfillService {
  private readonly logger = new Logger(HazelMediaSizeBackfillService.name);

  constructor(
    private readonly mediaRepository: MediaRepository,
    private readonly storageService: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async backfillSizes(): Promise<void> {
    // EXISTS subquery instead of innerJoin: TypeORM parses
    // `studio_schema.recording_takes` as `alias.relation` (splits on dot) and
    // throws "alias was not found". Schema in entity metadata, not join target.
    const candidates = await this.mediaRepository
      .createQueryBuilder('m')
      .where('m.size = 0')
      .andWhere(`m."createdAt" > NOW() - INTERVAL '24 hours'`)
      .andWhere('m."deletedAt" IS NULL')
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM "studio_schema"."recording_takes" rt
          INNER JOIN "studio_schema"."recordings" r ON r.id = rt."recordingId"
          WHERE rt."mediaId" = m.id AND r.type = :type
        )`,
        { type: RecordingTypeEnum.AI_PARTNER },
      )
      .orderBy('m."createdAt"', 'ASC')
      .limit(BACKFILL_BATCH_SIZE)
      .getMany();

    if (candidates.length === 0) return;

    this.logger.debug(
      `Hazel media size backfill — ${candidates.length} candidate(s)`,
    );

    let filled = 0;
    let stillMissing = 0;

    for (const media of candidates) {
      if (!media.s3Key) {
        stillMissing++;
        continue;
      }

      const size = await this.storageService.getObjectSize(media.s3Key);
      if (size === null || size === 0) {
        // file not in S3 yet (Agora still uploading) or HeadObject failed.
        // leave the row; next tick will retry until the 24h window closes.
        stillMissing++;
        continue;
      }

      try {
        await this.mediaRepository.updateMedia(media.id, { size });
        filled++;
      } catch (err: any) {
        this.logger.error(
          `Failed to update size for media ${media.id}: ${err.message}`,
        );
      }
    }

    if (filled > 0 || stillMissing > 0) {
      this.logger.log(
        `Hazel media size backfill done — filled=${filled}, stillMissing=${stillMissing}`,
      );
    }
  }
}
