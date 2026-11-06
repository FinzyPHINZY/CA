/** biome-ignore-all lint/style/useImportType: <> */
import {
  HAZEL_RECORDING_EVENTS,
  RecordingMode,
  RecordingRepository,
  RecordingStatus,
  RecordingTypeEnum,
  RehersalRepository,
} from '@app/common';
import { Logger } from '@nestjs/common';
import { HazelRecordingConsumer } from './hazel-recording.consumer';
import { HazelRecordingFinalizerService } from './hazel-recording-finalizer.service';

const STARTED_PAYLOAD = {
  rehearsalId: 'reh-1',
  userId: 'user-1',
  agoraChannelId: 'hazel_rec_reh-1',
  agoraResourceId: 'res-abc',
  agoraSid: 'sid-xyz',
  startedAt: '2026-05-19T10:00:00.000Z',
};

const STOP_PAYLOAD = {
  rehearsalId: 'reh-1',
  userId: 'user-1',
  agoraResourceId: 'res-abc',
  agoraSid: 'sid-xyz',
  agoraChannelId: 'hazel_rec_reh-1',
  stoppedAt: '2026-05-19T10:30:00.000Z',
};

const makeRmqContext = () => {
  const channel = { ack: jest.fn() };
  const message = { content: Buffer.from('') };
  return {
    channel,
    message,
    ctx: {
      getChannelRef: () => channel,
      getMessage: () => message,
    } as any,
  };
};

describe('HazelRecordingConsumer', () => {
  let consumer: HazelRecordingConsumer;
  let recordingRepository: jest.Mocked<Partial<RecordingRepository>>;
  let rehersalRepository: jest.Mocked<Partial<RehersalRepository>>;
  let finalizer: jest.Mocked<Partial<HazelRecordingFinalizerService>>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    recordingRepository = {
      findOne: jest.fn(),
      createEntity: jest.fn(),
    };
    rehersalRepository = {
      findById: jest.fn(),
    };
    finalizer = {
      finalize: jest.fn(),
      markFailed: jest.fn(),
    };

    consumer = new HazelRecordingConsumer(
      recordingRepository as any,
      rehersalRepository as any,
      finalizer as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('handleHazelRecordingStarted', () => {
    it('creates Recording row when none exists for (resourceId, sid)', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue(null);
      (rehersalRepository.findById as jest.Mock).mockResolvedValue({
        id: 'reh-1',
        projectId: 'proj-1',
        scriptId: 'scr-1',
        sceneId: 'scn-1',
      });
      (recordingRepository.createEntity as jest.Mock).mockResolvedValue({
        id: 'rec-1',
      });

      await consumer.handleHazelRecordingStarted(STARTED_PAYLOAD, ctx);

      expect(recordingRepository.createEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          type: RecordingTypeEnum.AI_PARTNER,
          mode: RecordingMode.AI_REHEARSAL,
          status: RecordingStatus.RECORDING,
          agoraResourceId: 'res-abc',
          cloudRecordingSid: 'sid-xyz',
          projectId: 'proj-1',
          scriptId: 'scr-1',
          sceneId: 'scn-1',
          userId: 'user-1',
          rehearsalId: 'reh-1',
        }),
      );
      expect(channel.ack).toHaveBeenCalled();
    });

    it('skips insert when an existing row already matches (idempotency)', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'rec-existing',
      });

      await consumer.handleHazelRecordingStarted(STARTED_PAYLOAD, ctx);

      expect(recordingRepository.createEntity).not.toHaveBeenCalled();
      expect(rehersalRepository.findById).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('acks and drops event when rehearsal is missing', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue(null);
      (rehersalRepository.findById as jest.Mock).mockResolvedValue(null);

      await consumer.handleHazelRecordingStarted(STARTED_PAYLOAD, ctx);

      expect(recordingRepository.createEntity).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('acks and drops when rehearsal lacks required FKs', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue(null);
      (rehersalRepository.findById as jest.Mock).mockResolvedValue({
        id: 'reh-1',
        projectId: null,
        scriptId: 'scr-1',
        sceneId: 'scn-1',
      });

      await consumer.handleHazelRecordingStarted(STARTED_PAYLOAD, ctx);

      expect(recordingRepository.createEntity).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('rethrows on transient DB error so RMQ redelivers', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockRejectedValue(
        new Error('connection refused'),
      );

      await expect(
        consumer.handleHazelRecordingStarted(STARTED_PAYLOAD, ctx),
      ).rejects.toThrow('connection refused');
      expect(channel.ack).not.toHaveBeenCalled();
    });
  });

  describe('handleHazelRecordingStopRequested', () => {
    it('drops with ack when no Recording row exists', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue(null);

      await consumer.handleHazelRecordingStopRequested(STOP_PAYLOAD, ctx);

      expect(finalizer.finalize).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('skips duplicate stop when recording already READY', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'rec-1',
        status: RecordingStatus.READY,
      });

      await consumer.handleHazelRecordingStopRequested(STOP_PAYLOAD, ctx);

      expect(finalizer.finalize).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('skips duplicate stop when recording already FAILED', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'rec-1',
        status: RecordingStatus.FAILED,
      });

      await consumer.handleHazelRecordingStopRequested(STOP_PAYLOAD, ctx);

      expect(finalizer.finalize).not.toHaveBeenCalled();
      expect(channel.ack).toHaveBeenCalled();
    });

    it('delegates to finalizer.finalize with user_ended reason on happy path', async () => {
      const { ctx, channel } = makeRmqContext();
      const row = { id: 'rec-1', status: RecordingStatus.RECORDING };
      (recordingRepository.findOne as jest.Mock).mockResolvedValue(row);
      (finalizer.finalize as jest.Mock).mockResolvedValue(row);

      await consumer.handleHazelRecordingStopRequested(STOP_PAYLOAD, ctx);

      expect(finalizer.finalize).toHaveBeenCalledWith(row, 'user_ended');
      expect(channel.ack).toHaveBeenCalled();
    });

    it('rethrows on finalizer failure so RMQ redelivers', async () => {
      const { ctx, channel } = makeRmqContext();
      (recordingRepository.findOne as jest.Mock).mockResolvedValue({
        id: 'rec-1',
        status: RecordingStatus.RECORDING,
      });
      (finalizer.finalize as jest.Mock).mockRejectedValue(
        new Error('Agora 500'),
      );

      await expect(
        consumer.handleHazelRecordingStopRequested(STOP_PAYLOAD, ctx),
      ).rejects.toThrow('Agora 500');
      expect(channel.ack).not.toHaveBeenCalled();
    });
  });

  // sanity: imported event constants are referenced (catches a bad rename).
  it('uses HAZEL_RECORDING_EVENTS constants', () => {
    expect(HAZEL_RECORDING_EVENTS.STARTED).toBe('hazel.recording.started');
    expect(HAZEL_RECORDING_EVENTS.STOP_REQUESTED).toBe(
      'hazel.recording.stop_requested',
    );
  });
});
