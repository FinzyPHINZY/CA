// Single source of truth for finalizing a Hazel Recording row.
//
// Both the STOP_REQUESTED consumer and the monitor cron call into this
// service so the Agora /stop call, Media row creation, status flip, and
// notification emit happen the same way regardless of trigger.
//
// Assumptions:
//   - caller has already verified the Recording row is not already finalized
//     (status NOT IN READY/FAILED). Idempotency belongs to the caller because
//     STOP_REQUESTED needs ack semantics, monitor needs row-locking semantics.
//   - recording.agoraResourceId, .cloudRecordingSid, .agoraChannelId all set.

import {
  HAZEL_RECORDING_EVENTS,
  MediaService,
  NOTIFICATIONS_SERVICE,
  Recording,
  RecordingRepository,
  RecordingStatus,
} from '@app/common';
import { MediaType } from '@app/common/enums/enums';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { AgoraCloudRecordingService } from '../studio/agora-cloud-recording.service';

// Hazel recording bot UID — matches the value used when the recording was
// acquired/started. Agora /stop requires the original uid.
const HAZEL_RECORDING_BOT_UID = '998';

export type HazelFinalizeReason = 'user_ended' | 'monitor_detected_stopped';

@Injectable()
export class HazelRecordingFinalizerService {
  private readonly logger = new Logger(HazelRecordingFinalizerService.name);
  private readonly s3Bucket: string;

  constructor(
    private readonly recordingRepository: RecordingRepository,
    private readonly cloudRecordingService: AgoraCloudRecordingService,
    private readonly mediaService: MediaService,
    private readonly configService: ConfigService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {
    this.s3Bucket = this.configService.get<string>('AWS_S3_BUCKET') || '';
  }

  /**
   * Run the full finalize pipeline: Agora stop → Media create → mark recording
   * READY (or FAILED on empty fileList) → notify user.
   *
   * Returns the saved Recording so callers can log the final id/status.
   */
  async finalize(
    recording: Recording,
    reason: HazelFinalizeReason,
  ): Promise<Recording> {
    const logTag = `[Hazel rec=${recording.id} reh=${recording.rehearsalId} sid=${recording.cloudRecordingSid}]`;

    if (
      !recording.agoraResourceId ||
      !recording.cloudRecordingSid ||
      !recording.agoraChannelId
    ) {
      throw new Error(
        `Cannot finalize recording ${recording.id} — missing Agora identifiers`,
      );
    }

    const startedAtIso = (recording.metaData as any)?.startedAt as
      | string
      | undefined;
    const sessionDurationMs = startedAtIso
      ? Date.now() - new Date(startedAtIso).getTime()
      : null;

    this.logger.log(
      `${logTag} finalize start — reason=${reason} channel=${recording.agoraChannelId} resourceId=${recording.agoraResourceId} sessionDurationMs=${sessionDurationMs ?? 'unknown'}`,
    );

    const stopResult = await this.cloudRecordingService.stop(
      recording.agoraResourceId,
      recording.cloudRecordingSid,
      recording.agoraChannelId,
      HAZEL_RECORDING_BOT_UID,
      'mix',
    );

    const fileList = stopResult.serverResponse.fileList || [];
    this.logger.log(
      `${logTag} Agora /stop response — fileCount=${fileList.length} uploadingStatus=${stopResult.serverResponse.uploadingStatus ?? 'unknown'} files=${JSON.stringify(fileList.map((f) => ({ fileName: f.fileName, trackType: f.trackType, mixedAllUser: f.mixedAllUser, isPlayable: f.isPlayable })))}`,
    );

    const mediaEntities: Awaited<ReturnType<MediaService['createMedia']>>[] =
      [];
    const mediaIds: string[] = [];

    for (const file of fileList) {
      if (!file.fileName) {
        this.logger.warn(`${logTag} skipping file with empty fileName`);
        continue;
      }

      const s3Key = file.fileName;
      const media = await this.mediaService.createMedia({
        type: MediaType.VIDEO,
        url: `https://${this.s3Bucket}.s3.amazonaws.com/${s3Key}`,
        size: 0, // backfilled async after S3 sync
        userId: recording.userId,
        fileName: s3Key.split('/').pop() || s3Key,
        contentType: file.trackType === 'audio' ? 'audio/mp4' : 'video/mp4',
        s3Key,
      });
      mediaEntities.push(media);
      mediaIds.push(media.id);
      this.logger.log(
        `${logTag} Media row created — mediaId=${media.id} s3Key=${s3Key} trackType=${file.trackType}`,
      );
    }

    const noMediaProduced = mediaEntities.length === 0;
    recording.status = noMediaProduced
      ? RecordingStatus.FAILED
      : RecordingStatus.READY;
    recording.takes = mediaEntities;
    recording.metaData = {
      ...(recording.metaData ?? {}),
      fileList,
      mediaIds,
      stoppedAt: new Date().toISOString(),
      finalizeReason: reason,
      sessionDurationMs,
      ...(noMediaProduced && { failureReason: 'no_media_produced' }),
    };

    const saved = await this.recordingRepository.save(recording);

    if (noMediaProduced) {
      this.logger.warn(
        `${logTag} FAILED — empty fileList from Agora. Most likely cause: actor's browser did not publish audio/video to channel ${recording.agoraChannelId} (sessionDurationMs=${sessionDurationMs ?? 'unknown'}, reason=${reason}). Check Agora console for publishers count in this channel.`,
      );
      this.notificationsClient.emit(HAZEL_RECORDING_EVENTS.FAILED, {
        rehearsalId: saved.rehearsalId,
        userId: saved.userId,
        stage: 'finalize',
        reason: 'no_media_produced',
        failedAt: new Date().toISOString(),
      });
    } else {
      this.logger.log(
        `${logTag} READY — ${mediaEntities.length} media file(s) captured, sessionDurationMs=${sessionDurationMs ?? 'unknown'}, reason=${reason}`,
      );
      this.notificationsClient.emit('recording.ready', {
        userId: saved.userId,
        recordingId: saved.id,
        sessionDate: new Date().toISOString(),
        durationSeconds: sessionDurationMs
          ? Math.round(sessionDurationMs / 1000)
          : null,
      });
    }

    return saved;
  }

  /**
   * Force-mark a recording FAILED without attempting Agora finalize.
   * Used by the monitor when Agora has lost the resource (400) or when an
   * orphan recording has exceeded the max session age.
   */
  async markFailed(recording: Recording, reason: string): Promise<Recording> {
    const logTag = `[Hazel rec=${recording.id} reh=${recording.rehearsalId} sid=${recording.cloudRecordingSid}]`;
    recording.status = RecordingStatus.FAILED;
    recording.metaData = {
      ...(recording.metaData ?? {}),
      failureReason: reason,
      failedAt: new Date().toISOString(),
    };
    const saved = await this.recordingRepository.save(recording);

    this.logger.warn(
      `${logTag} force-marked FAILED — reason=${reason} channel=${recording.agoraChannelId} resourceId=${recording.agoraResourceId}`,
    );
    this.notificationsClient.emit(HAZEL_RECORDING_EVENTS.FAILED, {
      rehearsalId: saved.rehearsalId,
      userId: saved.userId,
      stage: 'finalize',
      reason,
      failedAt: new Date().toISOString(),
    });

    return saved;
  }
}
