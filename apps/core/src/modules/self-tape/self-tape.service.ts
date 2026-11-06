/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import {
  AgoraSession,
  AgoraSessionRepository,
  AgoraSessionStatus,
  CdnService,
  MediaService,
  Recording,
  RecordingMode,
  RecordingRepository,
  RecordingStatus,
  StorageService,
} from '@app/common';
import { RecordingTypeEnum } from '@app/common/enums/recording.enum';
import { MediaType } from '@app/common/enums/enums';
import {
  CreateJobCommand,
  MediaConvertClient,
} from '@aws-sdk/client-mediaconvert';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgoraCloudRecordingService } from '../studio/agora-cloud-recording.service';
import { AgoraTokenService } from '../studio/agora-token.service';
import { CreateSelfTapeSessionDto } from './dto/create-self-tape-session.dto';
import { MarkTakeDto } from './dto/mark-take.dto';
import { StitchDto } from './dto/stitch.dto';
import { TitleCardDto } from './dto/title-card.dto';

// dedicated uid for the cloud recording bot — must match studio-recording.service.ts
const RECORDING_BOT_UID = '999';

@Injectable()
export class SelfTapeService {
  private readonly logger = new Logger(SelfTapeService.name);
  private readonly mediaConvert: MediaConvertClient | null;
  private readonly s3Client: S3Client;
  private readonly bucket: string;
  private readonly mediaConvertRole: string;
  private readonly mediaConvertEndpoint: string;

  constructor(
    private readonly agoraSessionRepository: AgoraSessionRepository,
    private readonly recordingRepository: RecordingRepository,
    private readonly mediaService: MediaService,
    private readonly cdnService: CdnService,
    private readonly storageService: StorageService,
    private readonly agoraTokenService: AgoraTokenService,
    private readonly cloudRecordingService: AgoraCloudRecordingService,
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
    }

    this.s3Client = new S3Client({
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
    });
  }

  // create a self-tape session - creates an Agora channel + Recording entity in SELF_TAPE mode.
  // returns token + channel info so the frontend can start recording.
  async createSession(
    userId: string,
    dto: CreateSelfTapeSessionDto,
  ): Promise<any> {
    // generate deterministic UID from user UUID
    const hex = userId.replace(/-/g, '').slice(0, 8);
    const uid = (parseInt(hex, 16) % 2_147_483_647) + 1;

    const channelName = `selftape_${userId}_${Date.now()}`;

    // create AgoraSession
    const session = await this.agoraSessionRepository.createEntity({
      channelName,
      bookingId: null,
      rehearsalId: null,
      creatorUserId: userId,
      status: AgoraSessionStatus.CREATED,
      cloudRecordingConfig: { mode: 'individual', selfTape: true },
    } as any);

    // create Recording entity
    const recording = await this.recordingRepository.createEntity({
      type: RecordingTypeEnum.SOLO,
      mode: RecordingMode.SELF_TAPE,
      status: RecordingStatus.PENDING,
      agoraChannelId: channelName,
      userId,
      projectId: dto.projectId,
      scriptId: dto.scriptId,
      sceneId: dto.sceneId,
      metaData: { takes: [], selfTape: true },
    } as any);

    // link recording to session
    await this.agoraSessionRepository.updateById(session.id, {
      recordingId: recording.id,
    } as any);

    // generate Agora token
    const tokenResult = this.agoraTokenService.generateRtcToken(
      channelName,
      uid,
      'publisher',
    );

    this.logger.log(
      `Self-tape session created: ${channelName}. Recording: ${recording.id}`,
    );

    return {
      success: true,
      message: 'Self-tape session created successfully',
      data: {
        session,
        recording,
        token: tokenResult.token,
        uid,
        appId: tokenResult.appId,
        channelName,
      },
    };
  }

  // start Agora cloud recording for a self-tape session.
  // called by the frontend after joining the Agora channel.
  async startRecording(recordingId: string, userId: string): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    const session = await this.agoraSessionRepository.findOne({
      where: { recordingId } as any,
    });
    if (!session) {
      throw new NotFoundException(
        'No Agora session found for this recording. Create a session first.',
      );
    }

    // idempotent — if already recording, return current state
    if (session.agoraResourceId && session.agoraSid) {
      this.logger.warn(
        `Recording already active for session ${session.id}. Returning current state.`,
      );
      return {
        success: true,
        message: 'Cloud recording already active',
        data: {
          recordingId,
          sessionId: session.id,
          status: 'recording',
        },
      };
    }

    // acquire + start cloud recording in individual mode
    const { resourceId } = await this.cloudRecordingService.acquire(
      session.channelName,
      RECORDING_BOT_UID,
    );

    const { sid } = await this.cloudRecordingService.start(
      resourceId,
      session.channelName,
      RECORDING_BOT_UID,
      'individual',
    );

    // update Agora session
    await this.agoraSessionRepository.updateById(session.id, {
      status: AgoraSessionStatus.RECORDING,
      agoraResourceId: resourceId,
      agoraSid: sid,
    } as any);

    // update recording status
    await this.recordingRepository.updateById(recordingId, {
      status: RecordingStatus.RECORDING,
    } as any);

    this.logger.log(
      `Cloud recording started for self-tape ${recordingId}. SID: ${sid}`,
    );

    return {
      success: true,
      message: 'Cloud recording started successfully',
      data: {
        recordingId,
        sessionId: session.id,
        resourceId,
        sid,
        status: 'recording',
      },
    };
  }

  // stop Agora cloud recording and link output files to recording.takes.
  async stopRecording(recordingId: string, userId: string): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    const session = await this.agoraSessionRepository.findOne({
      where: { recordingId } as any,
    });
    if (!session) {
      throw new NotFoundException('No Agora session found for this recording.');
    }

    if (!session.agoraResourceId || !session.agoraSid) {
      throw new BadRequestException(
        'No active cloud recording for this session. Call startRecording first.',
      );
    }

    const mode = 'individual' as const;

    const stopResult = await this.cloudRecordingService.stop(
      session.agoraResourceId,
      session.agoraSid,
      session.channelName,
      RECORDING_BOT_UID,
      mode,
    );

    // create Media entities from Agora output files
    const fileList = stopResult.serverResponse.fileList || [];
    const mediaEntities: any[] = [];

    for (const file of fileList) {
      if (!file.fileName) continue;

      const s3Key = file.fileName;
      // Agora's stop response doesn't include file size — hit S3 directly.
      // Treat missing/failed lookups as 0 so the Media row still gets created.
      const size = (await this.storageService.getObjectSize(s3Key)) ?? 0;
      const media = await this.mediaService.createMedia({
        type: MediaType.VIDEO,
        url: `https://${this.bucket}.s3.amazonaws.com/${s3Key}`,
        size,
        userId,
        fileName: s3Key.split('/').pop() || s3Key,
        contentType: file.trackType === 'audio' ? 'audio/mp4' : 'video/mp4',
        s3Key,
      });

      mediaEntities.push(media);
    }

    // link Media entities to recording.takes (the critical fix)
    if (mediaEntities.length > 0) {
      recording.takes = [...(recording.takes || []), ...mediaEntities];
      await this.recordingRepository.save(recording);
    }

    // update session status
    await this.agoraSessionRepository.updateById(session.id, {
      status: AgoraSessionStatus.ENDED,
    } as any);

    // store fileList in metaData for debugging
    const metaData = (recording.metaData || {}) as Record<string, any>;

    // provisional duration from already-marked takes; the stitch webhook will
    // later overwrite this with the precise MediaConvert value.
    const markedTakes = (metaData.takes ?? []) as Array<{
      durationMs?: number;
    }>;
    const summedTakeMs = markedTakes.reduce(
      (sum, t) => sum + (t.durationMs ?? 0),
      0,
    );
    const provisionalDurationMs = summedTakeMs > 0 ? summedTakeMs : null;

    await this.recordingRepository.updateById(recordingId, {
      status: RecordingStatus.PENDING,
      durationMs: provisionalDurationMs,
      metaData: {
        ...metaData,
        cloudRecording: {
          fileList,
          mediaIds: mediaEntities.map((m: any) => m.id),
          stoppedAt: new Date().toISOString(),
        },
      },
    } as any);

    this.logger.log(
      `Cloud recording stopped for self-tape ${recordingId}. Files: ${fileList.length}`,
    );

    return {
      success: true,
      message: 'Cloud recording stopped successfully',
      data: {
        recordingId,
        filesRecorded: fileList.length,
        mediaIds: mediaEntities.map((m: any) => m.id),
      },
    };
  }

  // mark a take within a self-tape recording - stores take timestamps relative to recording start for later trimming.
  async markTake(
    recordingId: string,
    userId: string,
    dto: MarkTakeDto,
  ): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    const metaData = (recording.metaData || {}) as Record<string, any>;
    const takes: any[] = metaData.takes || [];

    // check for duplicate take numbers
    const existing = takes.find((t: any) => t.takeNumber === dto.takeNumber);
    if (existing) {
      throw new BadRequestException(
        `Take ${dto.takeNumber} already exists for this recording`,
      );
    }

    if (dto.endMs <= dto.startMs) {
      throw new BadRequestException('endMs must be greater than startMs');
    }

    takes.push({
      takeNumber: dto.takeNumber,
      startMs: dto.startMs,
      endMs: dto.endMs,
      durationMs: dto.endMs - dto.startMs,
      markedAt: new Date().toISOString(),
    });

    // sort by take number
    takes.sort((a: any, b: any) => a.takeNumber - b.takeNumber);

    metaData.takes = takes;
    recording.metaData = metaData;

    await this.recordingRepository.updateById(recordingId, {
      metaData,
    } as any);

    this.logger.log(
      `Take ${dto.takeNumber} marked for recording ${recordingId} (${dto.startMs}ms - ${dto.endMs}ms)`,
    );

    return {
      success: true,
      message: 'Take marked successfully',
      data: recording,
    };
  }

  // set or update the title card for a self-tape recording.
  async setTitleCard(
    recordingId: string,
    userId: string,
    dto: TitleCardDto,
  ): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    const titleCardData = {
      actorName: dto.actorName,
      agentName: dto.agentName || null,
      sceneName: dto.sceneName,
      customText: dto.customText || null,
    };

    await this.recordingRepository.updateById(recordingId, {
      titleCard: JSON.stringify(titleCardData),
    } as any);

    recording.titleCard = JSON.stringify(titleCardData);

    this.logger.log(`Title card set for recording ${recordingId}`);

    return {
      success: true,
      message: 'Title card set successfully',
      data: recording,
    };
  }

  // submit a stitch job to trim selected takes and concatenate into a final MP4.
  // uses AWS MediaConvert for the transcoding.
  async submitStitch(
    recordingId: string,
    userId: string,
    dto: StitchDto,
  ): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    if (recording.status === RecordingStatus.PROCESSING) {
      throw new BadRequestException(
        'A stitch job is already in progress for this recording.',
      );
    }

    const metaData = (recording.metaData || {}) as Record<string, any>;
    const takes: any[] = metaData.takes || [];

    if (takes.length === 0) {
      throw new BadRequestException(
        'No takes have been marked for this recording',
      );
    }

    // validate that all requested takes exist
    for (const stitchTake of dto.takes) {
      const found = takes.find(
        (t: any) => t.takeNumber === stitchTake.takeNumber,
      );
      if (!found) {
        throw new BadRequestException(
          `Take ${stitchTake.takeNumber} not found in recording`,
        );
      }
    }

    // get the source media (first take from the recording)
    const sourceTake = recording.takes?.[0];
    if (!sourceTake?.s3Key) {
      throw new BadRequestException(
        'No source media available. Ensure cloud recording has completed.',
      );
    }

    // update recording status
    await this.recordingRepository.updateById(recordingId, {
      status: RecordingStatus.PROCESSING,
      metaData: {
        ...metaData,
        stitchRequest: {
          takes: dto.takes,
          includeTitleCard: dto.includeTitleCard,
          submittedAt: new Date().toISOString(),
        },
      },
    } as any);

    if (!this.mediaConvert) {
      // TODO: dev environments without MediaConvert can't actually stitch. We
      // used to flip status to READY here, but that masked downstream bugs
      // (no finalMedia, no durationMs). Revert to PENDING so the recording
      // doesn't sit in PROCESSING forever, and surface the no-op clearly.
      this.logger.warn(
        `MediaConvert not configured — stitch is a no-op for recording ${recordingId}`,
      );
      await this.recordingRepository.updateById(recordingId, {
        status: RecordingStatus.PENDING,
      } as any);
      return {
        success: true,
        message: 'Stitch skipped (MediaConvert not configured)',
        data: { recordingId, jobId: 'no-op', status: 'skipped' },
      };
    }

    const inputS3Uri = `s3://${this.bucket}/${sourceTake.s3Key}`;
    const outputPath = `self-tape/${recordingId}/final/`;
    const outputS3Uri = `s3://${this.bucket}/${outputPath}`;

    try {
      // build input clippings for each take
      const inputs: any[] = [];

      // prepend title card as a 5-second slate if requested.
      // uses the source video's first 5 seconds as a carrier with the title card PNG overlaid.
      if (dto.includeTitleCard && recording.titleCard) {
        const titleCardData = this.parseTitleCard(recording.titleCard);
        if (titleCardData) {
          const titleCardS3Key = await this.generateAndUploadTitleCard(
            recordingId,
            titleCardData,
          );

          inputs.push({
            FileInput: inputS3Uri,
            AudioSelectors: {
              'Audio Selector 1': {
                DefaultSelection: 'DEFAULT' as const,
              },
            },
            InputClippings: [
              {
                StartTimecode: '00:00:00:00',
                EndTimecode: '00:00:05:00',
              },
            ],
            ImageInserter: {
              InsertableImages: [
                {
                  ImageS3Uri: `s3://${this.bucket}/${titleCardS3Key}`,
                  Layer: 1,
                  ImageX: 0,
                  ImageY: 0,
                  Opacity: 100,
                  StartTime: '00:00:00:00',
                  FadeIn: 0,
                  FadeOut: 500,
                },
              ],
            },
          });
        }
      }

      // add take clippings from the source recording
      for (const stitchTake of dto.takes) {
        inputs.push({
          FileInput: inputS3Uri,
          AudioSelectors: {
            'Audio Selector 1': {
              DefaultSelection: 'DEFAULT' as const,
            },
          },
          InputClippings: [
            {
              StartTimecode: this.msToTimecode(stitchTake.startMs),
              EndTimecode: this.msToTimecode(stitchTake.endMs),
            },
          ],
        });
      }

      const jobCommand = new CreateJobCommand({
        Role: this.mediaConvertRole,
        Settings: {
          Inputs: inputs,
          OutputGroups: [
            {
              Name: 'SelfTapeFinal',
              OutputGroupSettings: {
                Type: 'FILE_GROUP_SETTINGS',
                FileGroupSettings: {
                  Destination: outputS3Uri,
                },
              },
              Outputs: [
                {
                  ContainerSettings: {
                    Container: 'MP4',
                    Mp4Settings: {},
                  },
                  VideoDescription: {
                    CodecSettings: {
                      Codec: 'H_264',
                      H264Settings: {
                        RateControlMode: 'QVBR',
                        MaxBitrate: 5000000,
                        QvbrSettings: { QvbrQualityLevel: 8 },
                      },
                    },
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
                  NameModifier: '_final',
                },
              ],
            },
          ],
        },
        UserMetadata: {
          recordingId,
          type: 'self-tape-stitch',
        },
      });

      const result = await this.mediaConvert.send(jobCommand);
      const jobId = result.Job?.Id || 'unknown';

      this.logger.log(
        `Stitch job ${jobId} submitted for recording ${recordingId}`,
      );

      return {
        success: true,
        message: 'Stitch job submitted successfully',
        data: { recordingId, jobId, status: 'in_progress' },
      };
    } catch (error) {
      this.logger.error(
        `Failed to submit stitch job for recording ${recordingId}`,
        error,
      );
      await this.recordingRepository.updateById(recordingId, {
        status: RecordingStatus.FAILED,
      } as any);
      throw new InternalServerErrorException(
        'Stitch job submission failed. Please try again.',
      );
    }
  }

  // get a signed download URL for the final stitched self-tape.
  async getExportUrl(recordingId: string, userId: string): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    if (recording.status !== RecordingStatus.READY) {
      throw new BadRequestException(
        `Recording is not ready for export. Current status: ${recording.status}`,
      );
    }

    // find the final stitched media (last mediaResource, or first take)
    const finalMedia =
      recording.mediaResources?.find((m) => m.fileName?.includes('_final')) ||
      recording.mediaResources?.[recording.mediaResources.length - 1] ||
      recording.takes?.[0];

    if (!finalMedia?.s3Key) {
      throw new NotFoundException(
        'No exportable media found for this recording',
      );
    }

    const url = this.cdnService.generateSignedUrl(finalMedia.s3Key);

    // build suggested filename
    const scene = recording.scene;
    const titleCard = this.parseTitleCard(recording.titleCard);
    const actorName = titleCard?.actorName || 'Actor';
    const sceneName = scene?.heading || 'Scene';
    const safeName = `${actorName}_${sceneName}_SelfTape.mp4`
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .replace(/_+/g, '_');

    return {
      success: true,
      message: 'Export URL generated successfully',
      data: { url, fileName: safeName, recording },
    };
  }

  // list self-tape recordings for a user (paginated).
  async listSessions(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<any> {
    const qb = this.recordingRepository
      .createQueryBuilder('recording')
      .where('recording.userId = :userId', { userId })
      .andWhere('recording.mode = :mode', { mode: RecordingMode.SELF_TAPE })
      .leftJoinAndSelect('recording.project', 'project')
      .leftJoinAndSelect('recording.scene', 'scene')
      .orderBy('recording.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await qb.getManyAndCount();
    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Self-tape sessions retrieved successfully',
      data: {
        items: items.map((r) => ({
          id: r.id,
          status: r.status,
          projectId: r.projectId,
          projectName: (r as any).project?.name ?? null,
          sceneId: r.sceneId,
          sceneHeading: (r as any).scene?.heading ?? null,
          takesCount: ((r.metaData as any)?.takes || []).length,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // soft-delete a self-tape recording.
  async deleteRecording(recordingId: string, userId: string): Promise<any> {
    const recording = await this.getOwnedRecording(recordingId, userId);

    if (recording.status === RecordingStatus.PROCESSING) {
      throw new BadRequestException(
        'Cannot delete a recording while a stitch job is in progress.',
      );
    }

    await this.recordingRepository.softDelete(recordingId);

    this.logger.log(`Self-tape recording ${recordingId} soft-deleted`);

    return {
      success: true,
      message: 'Self-tape recording deleted successfully',
    };
  }

  // generate a title card PNG (1920x1080, black bg, white text) and upload to S3.
  // returns the S3 key of the uploaded image.
  private async generateAndUploadTitleCard(
    recordingId: string,
    titleCard: {
      actorName: string;
      agentName: string | null;
      sceneName: string;
      customText: string | null;
    },
  ): Promise<string> {
    const width = 1920;
    const height = 1080;

    // build text lines
    const lines: { text: string; fontSize: number; y: number }[] = [];
    let currentY = 340;

    // actor name — large, primary
    lines.push({ text: titleCard.actorName, fontSize: 72, y: currentY });
    currentY += 110;

    // agent name — medium, secondary
    if (titleCard.agentName) {
      lines.push({ text: titleCard.agentName, fontSize: 42, y: currentY });
      currentY += 80;
    }

    // scene name — medium
    lines.push({ text: titleCard.sceneName, fontSize: 48, y: currentY });
    currentY += 80;

    // custom text — smaller
    if (titleCard.customText) {
      lines.push({ text: titleCard.customText, fontSize: 36, y: currentY });
    }

    // build SVG overlay
    const svgLines = lines
      .map(
        (l) =>
          `<text x="${width / 2}" y="${l.y}" font-family="Arial, Helvetica, sans-serif" font-size="${l.fontSize}" fill="white" text-anchor="middle">${this.escapeXml(l.text)}</text>`,
      )
      .join('\n');

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="black"/>
      ${svgLines}
    </svg>`;

    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

    const s3Key = `self-tape/${recordingId}/title-card.png`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: pngBuffer,
        ContentType: 'image/png',
      }),
    );

    this.logger.log(
      `Title card PNG uploaded for recording ${recordingId}: ${s3Key}`,
    );

    return s3Key;
  }

  // escape special XML characters for SVG text content.
  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // get a recording and verify ownership.
  private async getOwnedRecording(
    recordingId: string,
    userId: string,
  ): Promise<Recording> {
    const recording = await this.recordingRepository.findById(recordingId);
    if (!recording) {
      throw new NotFoundException(`Recording with ID ${recordingId} not found`);
    }
    if (recording.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access this recording',
      );
    }
    return recording;
  }

  // parse title card JSONB.
  private parseTitleCard(titleCard: string | null): {
    actorName: string;
    agentName: string | null;
    sceneName: string;
    customText: string | null;
  } | null {
    if (!titleCard) return null;
    try {
      return JSON.parse(titleCard);
    } catch {
      return null;
    }
  }

  // convert milliseconds to SMPTE timecode (HH:MM:SS:FF at 30fps).
  private msToTimecode(ms: number): string {
    const totalSeconds = ms / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const frames = Math.floor((totalSeconds % 1) * 30); // 30fps

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
  }
}
