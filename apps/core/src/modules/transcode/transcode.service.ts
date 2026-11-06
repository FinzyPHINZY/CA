/** biome-ignore-all lint/style/useImportType: <> */

import {
  MediaService,
  RecordingRepository,
  RecordingStatus,
  StorageService,
  TranscodeStatus,
  TranscodeVariant,
} from '@app/common';
import { MediaType } from '@app/common/enums/enums';
import {
  CreateJobCommand,
  GetJobCommand,
  MediaConvertClient,
} from '@aws-sdk/client-mediaconvert';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TranscodeJobResult {
  recordingId: string;
  jobId: string;
  status: TranscodeStatus;
  variants: TranscodeVariant[];
}

@Injectable()
export class TranscodeService {
  private readonly logger = new Logger(TranscodeService.name);
  private readonly mediaConvert: MediaConvertClient | null;
  private readonly bucket: string;
  private readonly mediaConvertRole: string;
  private readonly mediaConvertEndpoint: string;

  constructor(
    private readonly mediaService: MediaService,
    private readonly recordingRepository: RecordingRepository,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET') || '';
    this.mediaConvertRole =
      this.configService.get<string>('MEDIACONVERT_ROLE_ARN') || '';
    this.mediaConvertEndpoint =
      this.configService.get<string>('MEDIACONVERT_ENDPOINT') || '';

    if (this.mediaConvertEndpoint && this.mediaConvertRole) {
      this.mediaConvert = new MediaConvertClient({
        region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
        endpoint: this.mediaConvertEndpoint,
      });
    } else {
      this.mediaConvert = null;
      this.logger.warn(
        'MediaConvert not configured — transcoding will be skipped. Set MEDIACONVERT_ENDPOINT and MEDIACONVERT_ROLE_ARN to enable.',
      );
    }
  }

  // submit a transcoding job for a recording. creates 720p and audio-only variants from the original take.
  async submitRecordingTranscodeJob(recordingId: string): Promise<any> {
    const recording = await this.recordingRepository.findById(recordingId);
    if (!recording) {
      throw new NotFoundException(`Recording with ID ${recordingId} not found`);
    }

    // find the primary source media (first take)
    const sourceTake = recording.takes?.[0];
    if (!sourceTake || !sourceTake.s3Key) {
      throw new NotFoundException(
        `No source media found for recording ${recordingId}`,
      );
    }

    // if MediaConvert is not configured, this is a no-op (dev environments).
    // we used to flip status to READY here, but that masked downstream bugs
    // (no variants, no durationMs). leave the recording in whatever state it
    // was in and surface the skip clearly.
    if (!this.mediaConvert) {
      this.logger.warn(
        `MediaConvert not configured — transcode is a no-op for recording ${recordingId}`,
      );
      return {
        success: true,
        message: 'Transcode skipped (MediaConvert not configured)',
        data: {
          recordingId,
          jobId: 'no-op',
          status: TranscodeStatus.COMPLETED,
          variants: [TranscodeVariant.ORIGINAL],
        },
      };
    }

    // update recording status to PROCESSING
    await this.recordingRepository.updateById(recordingId, {
      status: RecordingStatus.PROCESSING,
    });

    const inputS3Uri = `s3://${this.bucket}/${sourceTake.s3Key}`;
    const outputBasePath = sourceTake.s3Key.replace(/\/[^/]+$/, '/variants/');
    const outputS3Uri = `s3://${this.bucket}/${outputBasePath}`;

    try {
      const jobCommand = new CreateJobCommand({
        Role: this.mediaConvertRole,
        Settings: {
          Inputs: [
            {
              FileInput: inputS3Uri,
              AudioSelectors: {
                'Audio Selector 1': {
                  DefaultSelection: 'DEFAULT',
                },
              },
            },
          ],
          OutputGroups: [
            // 720p MP4 variant
            {
              Name: '720p',
              OutputGroupSettings: {
                Type: 'FILE_GROUP_SETTINGS',
                FileGroupSettings: {
                  Destination: `${outputS3Uri}720p/`,
                },
              },
              Outputs: [
                {
                  ContainerSettings: {
                    Container: 'MP4',
                    Mp4Settings: {},
                  },
                  VideoDescription: {
                    Width: 1280,
                    Height: 720,
                    CodecSettings: {
                      Codec: 'H_264',
                      H264Settings: {
                        RateControlMode: 'QVBR',
                        MaxBitrate: 2000000,
                        QvbrSettings: { QvbrQualityLevel: 7 },
                      },
                    },
                  },
                  AudioDescriptions: [
                    {
                      CodecSettings: {
                        Codec: 'AAC',
                        AacSettings: {
                          Bitrate: 128000,
                          SampleRate: 48000,
                          CodingMode: 'CODING_MODE_2_0',
                        },
                      },
                    },
                  ],
                  NameModifier: '_720p',
                },
              ],
            },
            // Audio-only MP4 variant
            {
              Name: 'AudioOnly',
              OutputGroupSettings: {
                Type: 'FILE_GROUP_SETTINGS',
                FileGroupSettings: {
                  Destination: `${outputS3Uri}audio/`,
                },
              },
              Outputs: [
                {
                  ContainerSettings: {
                    Container: 'MP4',
                    Mp4Settings: {},
                  },
                  AudioDescriptions: [
                    {
                      CodecSettings: {
                        Codec: 'AAC',
                        AacSettings: {
                          Bitrate: 192000,
                          SampleRate: 48000,
                          CodingMode: 'CODING_MODE_2_0',
                        },
                      },
                    },
                  ],
                  NameModifier: '_audio',
                },
              ],
            },
          ],
        },
        UserMetadata: {
          recordingId,
        },
      });

      const result = await this.mediaConvert.send(jobCommand);
      const jobId = result.Job?.Id || 'unknown';

      this.logger.log(
        `MediaConvert job ${jobId} submitted for recording ${recordingId}`,
      );

      return {
        success: true,
        message: 'Transcode job submitted successfully',
        data: {
          recordingId,
          jobId,
          status: TranscodeStatus.IN_PROGRESS,
          variants: [
            TranscodeVariant.ORIGINAL,
            TranscodeVariant.HD_720P,
            TranscodeVariant.AUDIO_ONLY,
          ],
        },
      };
    } catch (error) {
      this.logger.error(
        `Failed to submit transcode job for recording ${recordingId}`,
        error,
      );
      await this.recordingRepository.updateById(recordingId, {
        status: RecordingStatus.FAILED,
      });
      return {
        success: false,
        message: 'Transcode job submission failed',
        data: {
          recordingId,
          jobId: 'failed',
          status: TranscodeStatus.FAILED,
          variants: [],
        },
      };
    }
  }

  // check the status of a MediaConvert job and finalize if complete.
  // called by a webhook or polling mechanism.
  async handleTranscodeComplete(
    jobId: string,
    recordingId: string,
  ): Promise<void> {
    if (!this.mediaConvert) {
      return;
    }

    try {
      const result = await this.mediaConvert.send(
        new GetJobCommand({ Id: jobId }),
      );

      const status = result.Job?.Status;

      if (status === 'COMPLETE') {
        // create media records for the generated variants
        const recording = await this.recordingRepository.findById(recordingId);
        if (!recording) return;

        if (recording.status === RecordingStatus.READY) {
          this.logger.log(
            `Transcode webhook retry ignored — recording ${recordingId} already READY`,
          );
          return;
        }

        const sourceTake = recording.takes?.[0];
        if (!sourceTake) return;

        const outputBasePath = sourceTake.s3Key?.replace(
          /\/[^/]+$/,
          '/variants/',
        );
        const sourceFileName = sourceTake.fileName || 'recording';
        const baseName = sourceFileName.replace(/\.[^.]+$/, '');

        // MediaConvert reports durationMs per output. Order matches the Outputs[]
        // we submitted (video first, audio second).
        const outputDetails =
          result.Job?.OutputGroupDetails?.flatMap(
            (g) => g.OutputDetails ?? [],
          ) ?? [];
        const videoDurationMs = outputDetails[0]?.DurationInMs ?? null;
        const audioDurationMs =
          outputDetails[1]?.DurationInMs ?? videoDurationMs;

        const video720Key = `${outputBasePath}720p/${baseName}_720p.mp4`;
        const audioKey = `${outputBasePath}audio/${baseName}_audio.mp4`;
        const [video720Size, audioSize] = await Promise.all([
          this.storageService.getObjectSize(video720Key),
          this.storageService.getObjectSize(audioKey),
        ]);

        // create 720p variant media record
        const variant720p = await this.mediaService.createMedia({
          type: MediaType.VIDEO,
          url: `https://${this.bucket}.s3.amazonaws.com/${video720Key}`,
          size: video720Size ?? 0,
          userId: recording.userId,
          fileName: `${baseName}_720p.mp4`,
          contentType: 'video/mp4',
          s3Key: video720Key,
          durationMs: videoDurationMs,
        });

        // create audio-only variant media record
        const audioVariant = await this.mediaService.createMedia({
          type: MediaType.AUDIO,
          url: `https://${this.bucket}.s3.amazonaws.com/${audioKey}`,
          size: audioSize ?? 0,
          userId: recording.userId,
          fileName: `${baseName}_audio.mp4`,
          contentType: 'audio/mp4',
          s3Key: audioKey,
          durationMs: audioDurationMs,
        });

        // add variants to recording's mediaResources
        const currentResources = recording.mediaResources || [];
        recording.mediaResources = [
          ...currentResources,
          variant720p,
          audioVariant,
        ];
        recording.durationMs = videoDurationMs;

        await this.recordingRepository.save(recording);
        await this.recordingRepository.updateById(recordingId, {
          status: RecordingStatus.READY,
        });

        this.logger.log(
          `Transcode completed for recording ${recordingId}: 720p + audio variants created (durationMs=${videoDurationMs})`,
        );
      } else if (status === 'ERROR') {
        await this.recordingRepository.updateById(recordingId, {
          status: RecordingStatus.FAILED,
        });
        this.logger.error(
          `Transcode failed for recording ${recordingId}: job ${jobId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to check transcode status for job ${jobId}`,
        error,
      );
    }
  }

  // handle completion of a self-tape stitch job.
  // creates a Media entity for the final stitched MP4 and links it to recording.mediaResources.
  async handleStitchComplete(
    jobId: string,
    recordingId: string,
  ): Promise<void> {
    if (!this.mediaConvert) {
      return;
    }

    try {
      const result = await this.mediaConvert.send(
        new GetJobCommand({ Id: jobId }),
      );

      const status = result.Job?.Status;

      if (status === 'COMPLETE') {
        const recording = await this.recordingRepository.findById(recordingId);
        if (!recording) return;

        if (recording.status === RecordingStatus.READY) {
          this.logger.log(
            `Stitch webhook retry ignored — recording ${recordingId} already READY`,
          );
          return;
        }

        // output path matches submitStitch(): self-tape/{recordingId}/final/{recordingId}_final.mp4
        const outputS3Key = `self-tape/${recordingId}/final/${recordingId}_final.mp4`;

        const outputDetails =
          result.Job?.OutputGroupDetails?.flatMap(
            (g) => g.OutputDetails ?? [],
          ) ?? [];
        const finalDurationMs = outputDetails[0]?.DurationInMs ?? null;

        const finalSize =
          (await this.storageService.getObjectSize(outputS3Key)) ?? 0;
        const finalMedia = await this.mediaService.createMedia({
          type: MediaType.VIDEO,
          url: `https://${this.bucket}.s3.amazonaws.com/${outputS3Key}`,
          size: finalSize,
          userId: recording.userId,
          fileName: `${recordingId}_final.mp4`,
          contentType: 'video/mp4',
          s3Key: outputS3Key,
          durationMs: finalDurationMs,
        });

        // link final media to recording.mediaResources
        const currentResources = recording.mediaResources || [];
        recording.mediaResources = [...currentResources, finalMedia];
        recording.durationMs = finalDurationMs;
        await this.recordingRepository.save(recording);

        await this.recordingRepository.updateById(recordingId, {
          status: RecordingStatus.READY,
        });

        this.logger.log(
          `Stitch completed for recording ${recordingId}: final MP4 at ${outputS3Key} (durationMs=${finalDurationMs})`,
        );
      } else if (status === 'ERROR') {
        await this.recordingRepository.updateById(recordingId, {
          status: RecordingStatus.FAILED,
        });
        this.logger.error(
          `Stitch failed for recording ${recordingId}: job ${jobId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to check stitch status for job ${jobId}`,
        error,
      );
    }
  }
}
