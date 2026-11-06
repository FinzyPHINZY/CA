// Safety-net cron for Hazel recordings.
//
// Covers two failure modes the STOP_REQUESTED event path cannot:
//   1. Client crashes / session.end never fires → STOP_REQUESTED never emitted.
//      Monitor detects the recording is still flagged RECORDING but Agora has
//      stopped (status 7/8) and calls the finalizer.
//   2. Agora silently reaps the recording (status 0/400 on query) → row gets
//      stuck forever. Monitor force-marks FAILED so it stops being polled.
//
// Orphan guard: recordings older than HAZEL_RECORDING_MAX_AGE_HOURS get
// force-marked FAILED with reason 'orphan_timeout' — guards the case where
// Agora itself is unreachable for an extended window.

import {
  RecordingRepository,
  RecordingStatus,
  RecordingTypeEnum,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AgoraCloudRecordingService } from '../studio/agora-cloud-recording.service';
import { HazelRecordingFinalizerService } from './hazel-recording-finalizer.service';

// any recording older than this is force-failed regardless of Agora state.
// matches HAZEL_MAX_SESSION_HOURS default from ai_service config.
const HAZEL_RECORDING_MAX_AGE_HOURS = 6;

@Injectable()
export class HazelRecordingMonitorService {
  private readonly logger = new Logger(HazelRecordingMonitorService.name);

  constructor(
    private readonly recordingRepository: RecordingRepository,
    private readonly cloudRecordingService: AgoraCloudRecordingService,
    private readonly finalizer: HazelRecordingFinalizerService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkPendingHazelRecordings(): Promise<void> {
    const pending = await this.recordingRepository
      .createQueryBuilder('recording')
      .where('recording.type = :type', { type: RecordingTypeEnum.AI_PARTNER })
      .andWhere('recording.status = :status', {
        status: RecordingStatus.RECORDING,
      })
      .andWhere('recording.agoraResourceId IS NOT NULL')
      .andWhere('recording.cloudRecordingSid IS NOT NULL')
      .andWhere('recording.deletedAt IS NULL')
      .getMany();

    if (pending.length === 0) return;

    this.logger.debug(`Checking ${pending.length} pending Hazel recording(s)`);

    const orphanCutoffMs =
      Date.now() - HAZEL_RECORDING_MAX_AGE_HOURS * 60 * 60 * 1000;

    for (const recording of pending) {
      const logTag = `[Hazel rec=${recording.id} reh=${recording.rehearsalId} sid=${recording.cloudRecordingSid}]`;
      try {
        // orphan guard runs first so an unreachable Agora can't keep us
        // re-querying a recording the user abandoned hours ago.
        if (recording.createdAt.getTime() < orphanCutoffMs) {
          this.logger.warn(
            `${logTag} orphan detected — createdAt=${recording.createdAt.toISOString()} ageHours=${((Date.now() - recording.createdAt.getTime()) / 3_600_000).toFixed(1)} → markFailed(orphan_timeout)`,
          );
          await this.finalizer.markFailed(recording, 'orphan_timeout');
          continue;
        }

        const result = await this.cloudRecordingService.query(
          recording.agoraResourceId!,
          recording.cloudRecordingSid!,
          'mix',
        );

        // Agora cloud recording status codes:
        //   5 = recording normally
        //   6 = paused
        //   7 = stopped
        //   8 = exited
        const { status } = result.serverResponse;
        const fileCount = result.serverResponse.fileList?.length ?? 0;
        this.logger.debug(
          `${logTag} Agora /query — status=${status} fileCount=${fileCount}`,
        );

        if (status === 7 || status === 8) {
          // re-fetch under the same try so a concurrent STOP_REQUESTED that
          // finalized between our query and finalize call doesn't trigger a
          // second Agora /stop or duplicate Media rows.
          const fresh = await this.recordingRepository.findOne({
            where: { id: recording.id },
            relations: ['takes'],
            withDeleted: false,
          });
          if (!fresh || fresh.status !== RecordingStatus.RECORDING) {
            this.logger.debug(
              `Recording ${recording.id} already finalized by another path; skipping`,
            );
            continue;
          }

          this.logger.warn(
            `${logTag} Agora reports status=${status} (stopped/exited) without a STOP_REQUESTED. This usually means Agora hit maxIdleTime (120s with no published streams) and self-stopped. Running finalizer.`,
          );
          await this.finalizer.finalize(fresh, 'monitor_detected_stopped');
        } else if (status === 6) {
          this.logger.warn(
            `${logTag} Agora reports paused — leaving for next tick`,
          );
        }
      } catch (err: any) {
        // Agora 400 = resource/sid no longer exists. Stop polling this row.
        const statusCode =
          err?.status ?? err?.response?.status ?? err?.response?.statusCode;
        if (statusCode === 400) {
          this.logger.warn(
            `${logTag} Agora /query returned 400 — resource lost (likely already reaped). markFailed(agora_resource_lost).`,
          );
          await this.finalizer
            .markFailed(recording, 'agora_resource_lost')
            .catch((markErr: any) =>
              this.logger.error(
                `${logTag} markFailed itself failed: ${markErr.message}`,
              ),
            );
          continue;
        }

        this.logger.error(
          `${logTag} Agora /query failed (non-400): statusCode=${statusCode} message=${err.message}`,
        );
      }
    }
  }
}
