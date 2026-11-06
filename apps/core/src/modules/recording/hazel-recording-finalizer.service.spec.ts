/** biome-ignore-all lint/style/useImportType: <> */
import {
  HAZEL_RECORDING_EVENTS,
  MediaService,
  RecordingRepository,
  RecordingStatus,
} from '@app/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { AgoraCloudRecordingService } from '../studio/agora-cloud-recording.service';
import { HazelRecordingFinalizerService } from './hazel-recording-finalizer.service';

const makeRecording = (overrides: Record<string, any> = {}) => ({
  id: 'rec-1',
  rehearsalId: 'reh-1',
  userId: 'user-1',
  agoraResourceId: 'res-abc',
  cloudRecordingSid: 'sid-xyz',
  agoraChannelId: 'hazel_rec_reh-1',
  status: RecordingStatus.RECORDING,
  metaData: { source: 'hazel' },
  takes: [],
  ...overrides,
});

describe('HazelRecordingFinalizerService', () => {
  let service: HazelRecordingFinalizerService;
  let recordingRepository: jest.Mocked<Partial<RecordingRepository>>;
  let cloudRecordingService: jest.Mocked<Partial<AgoraCloudRecordingService>>;
  let mediaService: jest.Mocked<Partial<MediaService>>;
  let configService: jest.Mocked<Partial<ConfigService>>;
  let notificationsClient: jest.Mocked<Partial<ClientProxy>>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    recordingRepository = {
      save: jest.fn().mockImplementation((rec: any) => Promise.resolve(rec)),
    };
    cloudRecordingService = {
      stop: jest.fn(),
    };
    mediaService = {
      createMedia: jest.fn(),
    };
    configService = {
      get: jest.fn().mockReturnValue('test-bucket'),
    };
    notificationsClient = {
      emit: jest.fn().mockReturnValue({ subscribe: jest.fn() }),
    };

    service = new HazelRecordingFinalizerService(
      recordingRepository as any,
      cloudRecordingService as any,
      mediaService as any,
      configService as any,
      notificationsClient as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('finalize', () => {
    it('throws when recording lacks Agora identifiers', async () => {
      const recording = makeRecording({
        agoraResourceId: null,
      });

      await expect(
        service.finalize(recording as any, 'user_ended'),
      ).rejects.toThrow(/missing Agora identifiers/);
    });

    it('happy path: creates Media per file, marks READY, emits recording.ready', async () => {
      const recording = makeRecording();
      (cloudRecordingService.stop as jest.Mock).mockResolvedValue({
        resourceId: 'res-abc',
        sid: 'sid-xyz',
        serverResponse: {
          fileList: [
            {
              fileName: 'recordings/hazel/x/2026-05-19/file1.mp4',
              trackType: 'video',
            },
            {
              fileName: 'recordings/hazel/x/2026-05-19/file2.m4a',
              trackType: 'audio',
            },
          ],
        },
      });
      (mediaService.createMedia as jest.Mock).mockImplementation((data: any) =>
        Promise.resolve({
          id: `media-${data.s3Key.split('/').pop()}`,
          ...data,
        }),
      );

      const result = await service.finalize(recording as any, 'user_ended');

      expect(cloudRecordingService.stop).toHaveBeenCalledWith(
        'res-abc',
        'sid-xyz',
        'hazel_rec_reh-1',
        '998',
        'mix',
      );
      expect(mediaService.createMedia).toHaveBeenCalledTimes(2);
      expect(mediaService.createMedia).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          s3Key: 'recordings/hazel/x/2026-05-19/file2.m4a',
          contentType: 'audio/mp4',
          userId: 'user-1',
        }),
      );

      expect(result.status).toBe(RecordingStatus.READY);
      expect(result.takes).toHaveLength(2);
      expect(result.metaData).toEqual(
        expect.objectContaining({
          source: 'hazel',
          finalizeReason: 'user_ended',
          mediaIds: ['media-file1.mp4', 'media-file2.m4a'],
        }),
      );
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        'recording.ready',
        expect.objectContaining({
          userId: 'user-1',
          recordingId: 'rec-1',
        }),
      );
    });

    it('empty fileList → FAILED status + HAZEL FAILED emit, no recording.ready', async () => {
      const recording = makeRecording();
      (cloudRecordingService.stop as jest.Mock).mockResolvedValue({
        resourceId: 'res-abc',
        sid: 'sid-xyz',
        serverResponse: { fileList: [] },
      });

      const result = await service.finalize(recording as any, 'user_ended');

      expect(result.status).toBe(RecordingStatus.FAILED);
      expect(result.takes).toEqual([]);
      expect(result.metaData).toEqual(
        expect.objectContaining({ failureReason: 'no_media_produced' }),
      );
      expect(mediaService.createMedia).not.toHaveBeenCalled();
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        HAZEL_RECORDING_EVENTS.FAILED,
        expect.objectContaining({
          rehearsalId: 'reh-1',
          reason: 'no_media_produced',
        }),
      );
      expect(notificationsClient.emit).not.toHaveBeenCalledWith(
        'recording.ready',
        expect.anything(),
      );
    });

    it('skips files with missing fileName', async () => {
      const recording = makeRecording();
      (cloudRecordingService.stop as jest.Mock).mockResolvedValue({
        resourceId: 'res-abc',
        sid: 'sid-xyz',
        serverResponse: {
          fileList: [
            { fileName: '', trackType: 'video' },
            { fileName: 'good.mp4', trackType: 'video' },
          ],
        },
      });
      (mediaService.createMedia as jest.Mock).mockImplementation((d: any) =>
        Promise.resolve({ id: 'media-good', ...d }),
      );

      const result = await service.finalize(recording as any, 'user_ended');

      expect(mediaService.createMedia).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(RecordingStatus.READY);
    });
  });

  describe('markFailed', () => {
    it('flips status to FAILED, sets failureReason, emits HAZEL FAILED', async () => {
      const recording = makeRecording();

      const result = await service.markFailed(
        recording as any,
        'orphan_timeout',
      );

      expect(result.status).toBe(RecordingStatus.FAILED);
      expect(result.metaData).toEqual(
        expect.objectContaining({ failureReason: 'orphan_timeout' }),
      );
      expect(recordingRepository.save).toHaveBeenCalled();
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        HAZEL_RECORDING_EVENTS.FAILED,
        expect.objectContaining({
          rehearsalId: 'reh-1',
          userId: 'user-1',
          stage: 'finalize',
          reason: 'orphan_timeout',
        }),
      );
    });

    it('does not call Agora /stop', async () => {
      const recording = makeRecording();
      await service.markFailed(recording as any, 'agora_resource_lost');
      expect(cloudRecordingService.stop).not.toHaveBeenCalled();
    });
  });
});
