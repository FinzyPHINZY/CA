/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// Agora Cloud Recording REST API base URL.
const AGORA_CLOUD_RECORDING_BASE = 'https://api.agora.io/v1/apps';

// recording mode: composite mixes all streams into one file, individual records per-user tracks.
export type CloudRecordingMode = 'mix' | 'individual';

export interface AcquireResult {
  resourceId: string;
}

export interface StartRecordingResult {
  resourceId: string;
  sid: string;
}

export interface StopRecordingResult {
  resourceId: string;
  sid: string;
  serverResponse: {
    fileListMode?: string;
    fileList?: Array<{
      fileName: string;
      trackType: string;
      uid: string;
      mixedAllUser: boolean;
      isPlayable: boolean;
      sliceStartTime: number;
    }>;
    uploadingStatus?: string;
  };
}

export interface QueryRecordingResult {
  resourceId: string;
  sid: string;
  serverResponse: {
    status: number; // 0=not started, 1=init, 2=uploading, 3=backing up, 4=connecting, 5=recording, 6=pausing, 7=stopped, 8=exit
    fileListMode?: string;
    fileList?: any[];
    sliceStartTime?: number;
  };
}

// S3 storage configuration for Agora cloud recording output.
export interface CloudRecordingStorageConfig {
  vendor: number; // 1 = AWS S3
  region: number;
  bucket: string;
  accessKey: string;
  secretKey: string;
  fileNamePrefix: string[];
}

// wraps Agora Cloud Recording RESTful API.
// all calls authenticated via Agora Customer Key/Secret (HTTP Basic Auth).
@Injectable()
export class AgoraCloudRecordingService {
  private readonly logger = new Logger(AgoraCloudRecordingService.name);
  private readonly appId: string;
  private readonly authHeader: string;
  private readonly s3Bucket: string;
  private readonly s3Region: string;
  private readonly s3AccessKey: string;
  private readonly s3SecretKey: string;

  constructor(private readonly configService: ConfigService) {
    this.appId = this.configService.get<string>('AGORA_APP_ID') || '';

    const customerKey =
      this.configService.get<string>('AGORA_CUSTOMER_KEY') || '';
    const customerSecret =
      this.configService.get<string>('AGORA_CUSTOMER_SECRET') || '';
    this.authHeader = `Basic ${Buffer.from(`${customerKey}:${customerSecret}`).toString('base64')}`;

    this.s3Bucket = this.configService.get<string>('AWS_S3_BUCKET') || '';
    this.s3Region = this.configService.get<string>('AWS_REGION') || 'us-east-1';
    this.s3AccessKey =
      this.configService.get<string>('AWS_ACCESS_KEY_ID') || '';
    this.s3SecretKey =
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '';
  }

  // step 1: acquire a resource ID for cloud recording.
  // must be called before start. resource ID is valid for 5 minutes.
  async acquire(channelName: string, uid: string): Promise<AcquireResult> {
    const url = `${AGORA_CLOUD_RECORDING_BASE}/${this.appId}/cloud_recording/acquire`;

    try {
      const response = await axios.post(
        url,
        {
          cname: channelName,
          uid,
          clientRequest: {
            resourceExpiredHour: 24,
            scene: 0, // 0 = real-time communication
          },
        },
        { headers: this.getHeaders() },
      );

      this.logger.log(
        `Cloud recording resource acquired for channel "${channelName}": ${response.data.resourceId}`,
      );

      return { resourceId: response.data.resourceId };
    } catch (error: any) {
      this.logger.error(
        `Failed to acquire cloud recording resource: ${error.message}`,
        error.response?.data,
      );
      throw new BadRequestException(
        'Failed to acquire cloud recording resource.',
      );
    }
  }

  // step 2: start cloud recording.
  // mode: 'mix' for composite (reader sessions), 'individual' for per-user tracks (self-tapes).
  async start(
    resourceId: string,
    channelName: string,
    uid: string,
    mode: CloudRecordingMode = 'mix',
  ): Promise<StartRecordingResult> {
    const url = `${AGORA_CLOUD_RECORDING_BASE}/${this.appId}/cloud_recording/resourceid/${resourceId}/mode/${mode}/start`;

    const storageConfig = this.buildStorageConfig(channelName);

    const clientRequest: any = {
      token: '', // empty string when no token auth for recording uid
      recordingConfig: {
        channelType: 0, // 0 = communication, 1 = live broadcast
        streamTypes: 2, // 0 = audio only, 1 = video only, 2 = audio + video
        streamMode: 'default',
        audioProfile: 1, // 0 = default, 1 = high quality (48kHz, stereo)
        maxIdleTime: 120, // auto-stop after 120s of silence
        transcodingConfig:
          mode === 'mix'
            ? {
                width: 1280,
                height: 720,
                fps: 30,
                bitrate: 1500,
                mixedVideoLayout: 1, // 0 = floating, 1 = best fit, 2 = vertical
              }
            : undefined,
      },
      storageConfig,
    };

    try {
      const response = await axios.post(
        url,
        { cname: channelName, uid, clientRequest },
        { headers: this.getHeaders() },
      );

      const sid = response.data.sid;

      this.logger.log(
        `Cloud recording started for channel "${channelName}". Mode: ${mode}, SID: ${sid}`,
      );

      return { resourceId, sid };
    } catch (error: any) {
      this.logger.error(
        `Failed to start cloud recording: ${error.message}`,
        error.response?.data,
      );
      throw new BadRequestException('Failed to start cloud recording.');
    }
  }

  // step 3: stop cloud recording.
  // returns file list of recordings in S3.
  async stop(
    resourceId: string,
    sid: string,
    channelName: string,
    uid: string,
    mode: CloudRecordingMode = 'mix',
  ): Promise<StopRecordingResult> {
    const url = `${AGORA_CLOUD_RECORDING_BASE}/${this.appId}/cloud_recording/resourceid/${resourceId}/sid/${sid}/mode/${mode}/stop`;

    try {
      const response = await axios.post(
        url,
        {
          cname: channelName,
          uid,
          clientRequest: {
            async_stop: false,
          },
        },
        { headers: this.getHeaders() },
      );

      this.logger.log(
        `Cloud recording stopped for channel "${channelName}". SID: ${sid}`,
      );

      return {
        resourceId,
        sid,
        serverResponse: response.data.serverResponse || {},
      };
    } catch (error: any) {
      const agoraStatus = error.response?.status;
      const agoraData = error.response?.data;
      const agoraHeaders = error.response?.headers;

      // 404 = Agora has already reaped/forgotten the resource (worker died,
      // idle timeout, or previous stop succeeded server-side). Treat as
      // already-stopped so the session can finalize cleanly. fileList will
      // be empty — the recording was never produced.
      if (agoraStatus === 404) {
        this.logger.warn(
          `Agora returned 404 stopping resource ${resourceId} sid ${sid} (channel "${channelName}"). Resource already gone — treating as already-stopped.`,
          { status: agoraStatus, data: agoraData },
        );
        return { resourceId, sid, serverResponse: {} };
      }

      this.logger.error(`Failed to stop cloud recording: ${error.message}`, {
        status: agoraStatus,
        data: agoraData,
        headers: agoraHeaders,
      });
      if (error.stack) {
        this.logger.error(`[stop] stack: ${error.stack}`);
      }
      throw new BadRequestException('Failed to stop cloud recording.');
    }
  }

  // query the status of an active cloud recording.
  async query(
    resourceId: string,
    sid: string,
    mode: CloudRecordingMode = 'mix',
  ): Promise<QueryRecordingResult> {
    const url = `${AGORA_CLOUD_RECORDING_BASE}/${this.appId}/cloud_recording/resourceid/${resourceId}/sid/${sid}/mode/${mode}/query`;

    try {
      const response = await axios.get(url, {
        headers: this.getHeaders(),
      });

      return {
        resourceId,
        sid,
        serverResponse: response.data.serverResponse || {},
      };
    } catch (error: any) {
      const agoraStatus = error.response?.status;
      const agoraData = error.response?.data;
      const agoraHeaders = error.response?.headers;
      this.logger.error(`Failed to query cloud recording: ${error.message}`, {
        status: agoraStatus,
        data: agoraData,
        headers: agoraHeaders,
      });
      throw new BadRequestException('Failed to query cloud recording status.');
    }
  }

  // build the S3 storage config for Agora cloud recording output.
  // path format: recordings/{channelName}/{date}/{sid}/
  private buildStorageConfig(channelName: string): CloudRecordingStorageConfig {
    const datePrefix = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    return {
      vendor: 1, // 1 = AWS S3
      region: this.mapAwsRegionToAgoraRegion(this.s3Region),
      bucket: this.s3Bucket,
      accessKey: this.s3AccessKey,
      secretKey: this.s3SecretKey,
      fileNamePrefix: ['recordings', channelName, datePrefix],
    };
  }

  // map AWS region string to Agora's numeric region code.
  // see: https://docs.agora.io/en/cloud-recording/reference/rest-api/start
  private mapAwsRegionToAgoraRegion(awsRegion: string): number {
    const regionMap: Record<string, number> = {
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
      'ap-northeast-3': 20,
      'eu-north-1': 21,
      'me-south-1': 22,
    };

    return regionMap[awsRegion] ?? 0; // default to us-east-1
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
    };
  }
}
