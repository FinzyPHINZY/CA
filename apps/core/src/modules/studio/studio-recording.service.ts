/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  AgoraSession,
  AgoraSessionRepository,
  MediaService,
  NOTIFICATIONS_SERVICE,
  RecordingRepository,
  UsageRecordRepository,
} from '@app/common';
import { MediaType } from '@app/common/enums/enums';
import { RecordingTypeEnum } from '@app/common/enums/recording.enum';
import {
  AgoraSessionStatus,
  RecordingMode,
  RecordingStatus,
  UsageService,
} from '@app/common/enums/studio.enum';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AgoraCloudRecordingService,
  CloudRecordingMode,
} from './agora-cloud-recording.service';

// dedicated uid for the cloud recording bot. must not collide with real user uids.
const RECORDING_BOT_UID = '999';

@Injectable()
export class StudioRecordingService {
  private readonly logger = new Logger(StudioRecordingService.name);

  constructor(
    private readonly cloudRecordingService: AgoraCloudRecordingService,
    private readonly agoraSessionRepository: AgoraSessionRepository,
    private readonly recordingRepository: RecordingRepository,
    private readonly mediaService: MediaService,
    private readonly usageRecordRepository: UsageRecordRepository,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
  ) {}

  // start cloud recording for an Agora session.
  // called automatically when session transitions to ACTIVE, or manually via API.
  async startRecording(
    session: AgoraSession,
    mode: CloudRecordingMode = 'mix',
  ): Promise<AgoraSession> {
    if (session.agoraResourceId && session.agoraSid) {
      this.logger.warn(
        `Recording already active for session ${session.id}. Skipping start.`,
      );
      return session;
    }

    // step 1: acquire resource
    const { resourceId } = await this.cloudRecordingService.acquire(
      session.channelName,
      RECORDING_BOT_UID,
    );

    // step 2: start recording
    const { sid } = await this.cloudRecordingService.start(
      resourceId,
      session.channelName,
      RECORDING_BOT_UID,
      mode,
    );

    // step 3: store on AgoraSession
    await this.agoraSessionRepository.updateById(session.id, {
      status: AgoraSessionStatus.RECORDING,
      agoraResourceId: resourceId,
      agoraSid: sid,
      cloudRecordingConfig: { mode },
    } as any);

    session.agoraResourceId = resourceId;
    session.agoraSid = sid;
    session.status = AgoraSessionStatus.RECORDING;
    session.cloudRecordingConfig = { mode };

    this.logger.log(
      `Cloud recording started for session ${session.id}. SID: ${sid}`,
    );

    return session;
  }

  // stop cloud recording and create Recording + Media entities.
  async stopRecording(session: AgoraSession): Promise<void> {
    if (!session.agoraResourceId || !session.agoraSid) {
      this.logger.warn(
        `No active recording for session ${session.id}. Skipping stop.`,
      );
      return;
    }

    const mode: CloudRecordingMode =
      (session.cloudRecordingConfig as any)?.mode || 'mix';

    const stopResult = await this.cloudRecordingService.stop(
      session.agoraResourceId,
      session.agoraSid,
      session.channelName,
      RECORDING_BOT_UID,
      mode,
    );

    // create Media entities for each output file
    const fileList = stopResult.serverResponse.fileList || [];
    const mediaEntities: any[] = [];
    const mediaIds: string[] = [];

    for (const file of fileList) {
      if (!file.fileName) continue;

      const s3Key = file.fileName;
      const media = await this.mediaService.createMedia({
        type: MediaType.VIDEO,
        url: `https://${this.getS3Bucket()}.s3.amazonaws.com/${s3Key}`,
        size: 0, // actual size determined after S3 sync
        userId: session.creatorUserId,
        fileName: s3Key.split('/').pop() || s3Key,
        contentType: file.trackType === 'audio' ? 'audio/mp4' : 'video/mp4',
        s3Key,
      });

      mediaEntities.push(media);
      mediaIds.push(media.id);

      this.logger.log(
        `Media entity created for recording file: ${s3Key} (Media ID: ${media.id})`,
      );
    }

    // clear resourceId/sid immediately after successful Agora stop so any subsequent
    // stop call hits the guard and returns cleanly instead of hitting Agora again.
    await this.agoraSessionRepository.updateById(session.id, {
      agoraResourceId: null,
      agoraSid: null,
    } as any);
    session.agoraResourceId = null;
    session.agoraSid = null;

    // create Recording entity if we have a rehearsal or booking context
    if (session.rehearsalId || session.bookingId) {
      const recordingMode = session.bookingId
        ? RecordingMode.READER_SESSION
        : RecordingMode.AI_REHEARSAL;

      const recordingType = session.bookingId
        ? RecordingTypeEnum.READER
        : RecordingTypeEnum.AI_PARTNER;

      // empty fileList = no media produced (worker died early, Agora reaped
      // resource before streams arrived, or stop hit a 404). Mark FAILED so
      // the recording isn't surfaced as a usable take.
      const noMediaProduced = mediaEntities.length === 0;
      const recordingStatus = noMediaProduced
        ? RecordingStatus.FAILED
        : RecordingStatus.READY;

      try {
        const recording = await this.recordingRepository.createEntity({
          type: recordingType,
          mode: recordingMode,
          status: recordingStatus,
          agoraChannelId: session.channelName,
          agoraResourceId: session.agoraResourceId,
          cloudRecordingSid: session.agoraSid,
          userId: session.creatorUserId,
          rehearsalId: session.rehearsalId || null,
          metaData: {
            fileList,
            mediaIds,
            cloudRecordingMode: mode,
            stoppedAt: new Date().toISOString(),
            ...(noMediaProduced && {
              failureReason: 'no_media_produced',
            }),
          },
        } as any);

        // link media to recording.takes
        if (mediaEntities.length > 0) {
          recording.takes = mediaEntities;
          await this.recordingRepository.save(recording);
        }

        // link recording to the session
        await this.agoraSessionRepository.updateById(session.id, {
          recordingId: recording.id,
        } as any);

        if (noMediaProduced) {
          this.logger.warn(
            `Recording entity created with status=FAILED for session ${session.id} — no media files produced. recordingId=${recording.id}`,
          );
        } else {
          this.logger.log(
            `Recording entity created: ${recording.id} for session ${session.id}`,
          );

          // notify only when there is actual media to play back
          this.notificationsClient.emit('recording.ready', {
            userId: session.creatorUserId,
            recordingId: recording.id,
            sessionDate: new Date().toISOString(),
            durationSeconds: null,
          });
        }
      } catch (error: any) {
        // recording creation is non-critical — log and continue
        this.logger.error(
          `Failed to create Recording entity for session ${session.id}: ${error.message}`,
        );
      }
    }

    // track usage
    await this.trackUsage(session);

    this.logger.log(
      `Cloud recording stopped for session ${session.id}. Files: ${fileList.length}`,
    );
  }

  // query the status of an active cloud recording.
  async queryRecording(
    session: AgoraSession,
  ): Promise<{ status: number; serverResponse: any } | null> {
    if (!session.agoraResourceId || !session.agoraSid) {
      return null;
    }

    const mode: CloudRecordingMode =
      (session.cloudRecordingConfig as any)?.mode || 'mix';

    const result = await this.cloudRecordingService.query(
      session.agoraResourceId,
      session.agoraSid,
      mode,
    );

    return {
      status: result.serverResponse.status,
      serverResponse: result.serverResponse,
    };
  }

  // create a solo recording session — single-user channel with immediate cloud recording.
  async createSoloSession(
    userId: string,
    options: {
      rehearsalId?: string;
      projectId: string;
      scriptId: string;
      sceneId: string;
    },
  ): Promise<{
    session: AgoraSession;
    token: string;
    uid: number;
    appId: string;
  }> {
    // import uidFromUuid logic inline to avoid circular deps
    const hex = userId.replace(/-/g, '').slice(0, 8);
    const uid = (parseInt(hex, 16) % 2_147_483_647) + 1;

    const channelName = options.rehearsalId
      ? `solo_${options.rehearsalId}`
      : `solo_${userId}_${Date.now()}`;

    // create AgoraSession
    const session = await this.agoraSessionRepository.createEntity({
      channelName,
      bookingId: null,
      rehearsalId: options.rehearsalId || null,
      creatorUserId: userId,
      status: AgoraSessionStatus.CREATED,
      cloudRecordingConfig: { mode: 'individual', solo: true },
    } as any);

    // create Recording entity upfront for solo sessions
    const recording = await this.recordingRepository.createEntity({
      type: RecordingTypeEnum.SOLO,
      mode: RecordingMode.SOLO_TELEPROMPTER,
      status: RecordingStatus.PENDING,
      agoraChannelId: channelName,
      userId,
      projectId: options.projectId,
      scriptId: options.scriptId,
      sceneId: options.sceneId,
      rehearsalId: options.rehearsalId || null,
    } as any);

    // link recording to session
    await this.agoraSessionRepository.updateById(session.id, {
      recordingId: recording.id,
    } as any);

    this.logger.log(
      `Solo session created: ${channelName}. Session: ${session.id}, Recording: ${recording.id}`,
    );

    // the frontend will join the channel and call startRecording once ready
    // generate a token for the actor
    // NOTE: we import AgoraTokenService lazily to keep this service focused
    // the controller will handle token generation using AgoraTokenService

    return {
      session,
      token: '', // controller fills this via AgoraTokenService
      uid,
      appId: '', // controller fills this
    };
  }

  // calculate and record Agora minutes usage.
  private async trackUsage(session: AgoraSession): Promise<void> {
    if (!session.startedAt) return;

    const endedAt = session.endedAt || new Date();
    const durationMs = endedAt.getTime() - session.startedAt.getTime();
    const durationMinutes = Math.ceil(durationMs / 60_000);

    if (durationMinutes <= 0) return;

    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    try {
      await this.usageRecordRepository.createEntity({
        userId: session.creatorUserId,
        service: UsageService.AGORA_MINUTES,
        quantity: durationMinutes,
        unit: 'minutes',
        rehearsalId: session.rehearsalId || null,
        recordingId: session.recordingId || null,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
      } as any);

      this.logger.log(
        `Usage tracked: ${durationMinutes} Agora minutes for user ${session.creatorUserId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to track usage for session ${session.id}: ${error.message}`,
      );
    }
  }

  private getS3Bucket(): string {
    // accessed via the cloud recording service's config, but we need it here for URL construction
    return process.env.AWS_S3_BUCKET || '';
  }
}
