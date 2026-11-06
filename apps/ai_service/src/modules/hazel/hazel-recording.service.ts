// hazelRecordingService

// starts and stops Agora cloud recording for optional Hazel session recording.
// mirrors the AgoraCloudRecordingService pattern from core but is self-contained in ai_service — recording state is stored in Redis (HazelSessionState) rather than the DB, since Hazel sessions are Redis-only.
// recording bot UID is fixed at 998 to avoid collisions with real users and the studio recording bot (999).

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import axios from 'axios';
import { HAZEL_RECORDING_EVENTS } from '@app/common';
import { HazelSessionService } from './hazel-session.service';

const AGORA_CLOUD_RECORDING_BASE = 'https://api.agora.io/v1/apps';
const RECORDING_BOT_UID = '998';

@Injectable()
export class HazelRecordingService {
  private readonly logger = new Logger(HazelRecordingService.name);

  private readonly appId: string;
  private readonly authHeader: string;
  private readonly s3Bucket: string;
  private readonly s3Region: string;
  private readonly s3AccessKey: string;
  private readonly s3SecretKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: HazelSessionService,
    @Inject('CORE_SERVICE') private readonly coreClient: ClientProxy,
  ) {
    this.appId = this.configService.get<string>('AGORA_APP_ID', '');

    const key = this.configService.get<string>('AGORA_CUSTOMER_KEY', '');
    const secret = this.configService.get<string>('AGORA_CUSTOMER_SECRET', '');
    this.authHeader = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;

    this.s3Bucket = this.configService.get<string>('AWS_S3_BUCKET', '');
    this.s3Region = this.configService.get<string>('AWS_REGION', 'us-east-1');
    this.s3AccessKey = this.configService.get<string>('AWS_ACCESS_KEY_ID', '');
    this.s3SecretKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
      '',
    );
  }

  /**
   * Acquire a recording resource, start cloud recording, and persist the
   * resourceId + sid into the Redis session state.
   *
   * Called from onSessionStart when recordSession === true.
   * Errors are caught by the caller and logged — recording failure must not
   * abort the rehearsal session itself.
   */
  async startRecording(
    rehearsalId: string,
    channelName: string,
    userId: string,
  ): Promise<void> {
    const logTag = `[Hazel reh=${rehearsalId}]`;
    this.logger.log(
      `${logTag} startRecording invoked — channel=${channelName} userId=${userId} botUid=${RECORDING_BOT_UID}`,
    );

    // step 1: acquire resource
    const acquireUrl = `${AGORA_CLOUD_RECORDING_BASE}/${this.appId}/cloud_recording/acquire`;
    const acquireRes = await axios.post(
      acquireUrl,
      {
        cname: channelName,
        uid: RECORDING_BOT_UID,
        clientRequest: { resourceExpiredHour: 24, scene: 0 },
      },
      { headers: this.headers() },
    );
    const resourceId: string = acquireRes.data.resourceId;
    this.logger.log(
      `${logTag} Agora /acquire OK — resourceId=${resourceId} status=${acquireRes.status}`,
    );

    // step 2: start recording in 'mix' mode (composite audio+video)
    const startUrl = `${AGORA_CLOUD_RECORDING_BASE}/${this.appId}/cloud_recording/resourceid/${resourceId}/mode/mix/start`;
    const datePrefix = new Date().toISOString().split('T')[0];
    const startRes = await axios.post(
      startUrl,
      {
        cname: channelName,
        uid: RECORDING_BOT_UID,
        clientRequest: {
          token: '',
          recordingConfig: {
            channelType: 0,
            streamTypes: 2,
            streamMode: 'default',
            audioProfile: 1,
            maxIdleTime: 120,
            transcodingConfig: {
              width: 1280,
              height: 720,
              fps: 30,
              bitrate: 1500,
              mixedVideoLayout: 1,
            },
          },
          storageConfig: {
            vendor: 1,
            region: this.mapRegion(this.s3Region),
            bucket: this.s3Bucket,
            accessKey: this.s3AccessKey,
            secretKey: this.s3SecretKey,
            fileNamePrefix: ['recordings', 'hazel', channelName, datePrefix],
          },
        },
      },
      { headers: this.headers() },
    );
    const sid: string = startRes.data.sid;
    this.logger.log(
      `${logTag} Agora /start OK — sid=${sid} status=${startRes.status} mode=mix maxIdleTime=120s storage=s3://${this.s3Bucket}/recordings/hazel/${channelName}/${datePrefix}/`,
    );

    // step 3: persist into Redis session state
    await this.sessionService.updateSession(rehearsalId, {
      agoraResourceId: resourceId,
      agoraSid: sid,
    });

    // step 4: emit STARTED event so core creates the Recording row.
    // emit is fire-and-forget at the transport layer (RMQ); failures here
    // would only mean the broker is unreachable, which is logged below.
    this.coreClient.emit(HAZEL_RECORDING_EVENTS.STARTED, {
      rehearsalId,
      userId,
      agoraChannelId: channelName,
      agoraResourceId: resourceId,
      agoraSid: sid,
      startedAt: new Date().toISOString(),
    });

    this.logger.log(
      `${logTag} STARTED event emitted to core — resourceId=${resourceId} sid=${sid}`,
    );
  }

  /**
   * Request the core service to finalize the Hazel recording.
   *
   * ai_service no longer owns the Agora /stop call — core owns it because the
   * Recording row, Media rows, and notification emit must happen transactionally
   * with the stop response. We only emit a STOP_REQUESTED event carrying the
   * Agora identifiers the consumer needs.
   *
   * Non-fatal: a missing session or missing Agora ids just means there is
   * nothing to finalize (recording was never started or already cleaned).
   */
  async requestStop(rehearsalId: string): Promise<void> {
    const logTag = `[Hazel reh=${rehearsalId}]`;
    const state = await this.sessionService
      .getSession(rehearsalId)
      .catch(() => null);
    if (
      !state?.agoraResourceId ||
      !state?.agoraSid ||
      !state?.recordingChannelName
    ) {
      this.logger.warn(
        `${logTag} requestStop: no active recording — skipping (resourceId=${state?.agoraResourceId ?? 'null'} sid=${state?.agoraSid ?? 'null'} channel=${state?.recordingChannelName ?? 'null'})`,
      );
      return;
    }

    this.coreClient.emit(HAZEL_RECORDING_EVENTS.STOP_REQUESTED, {
      rehearsalId,
      userId: state.userId,
      agoraResourceId: state.agoraResourceId,
      agoraSid: state.agoraSid,
      agoraChannelId: state.recordingChannelName,
      stoppedAt: new Date().toISOString(),
    });

    this.logger.log(
      `${logTag} STOP_REQUESTED event emitted to core — resourceId=${state.agoraResourceId} sid=${state.agoraSid} channel=${state.recordingChannelName}`,
    );
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
    };
  }

  private mapRegion(awsRegion: string): number {
    const map: Record<string, number> = {
      'us-east-1': 0,
      'us-east-2': 1,
      'us-west-1': 2,
      'us-west-2': 3,
      'eu-west-1': 4,
      'eu-west-2': 5,
      'eu-west-3': 6,
      'eu-central-1': 7,
      'ap-southeast-1': 8,
      'ap-southeast-2': 9,
      'ap-northeast-1': 10,
      'ap-northeast-2': 11,
      'sa-east-1': 12,
      'ca-central-1': 13,
      'ap-south-1': 14,
      'cn-north-1': 15,
      'cn-northwest-1': 16,
      'us-gov-west-1': 17,
      'af-south-1': 18,
      'ap-east-1': 19,
    };
    return map[awsRegion] ?? 0;
  }
}
