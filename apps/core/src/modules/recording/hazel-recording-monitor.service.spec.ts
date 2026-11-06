/** biome-ignore-all lint/style/useImportType: <> */
import { RecordingRepository, RecordingStatus } from '@app/common';
import { Logger } from '@nestjs/common';
import { AgoraCloudRecordingService } from '../studio/agora-cloud-recording.service';
import { HazelRecordingFinalizerService } from './hazel-recording-finalizer.service';
import { HazelRecordingMonitorService } from './hazel-recording-monitor.service';

const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000 + 1; // 1ms past the 6h cutoff

const makeRecording = (overrides: Record<string, any> = {}) => ({
  id: 'rec-1',
  rehearsalId: 'reh-1',
  userId: 'user-1',
  agoraResourceId: 'res-abc',
  cloudRecordingSid: 'sid-xyz',
  agoraChannelId: 'hazel_rec_reh-1',
  status: RecordingStatus.RECORDING,
  createdAt: new Date(Date.now() - 60_000), // 1 min old by default
  ...overrides,
});

const makeBuilder = (rows: any[]) => {
  const builder: any = {};
  for (const method of ['where', 'andWhere', 'orderBy', 'limit', 'innerJoin']) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }
  builder.getMany = jest.fn().mockResolvedValue(rows);
  return builder;
};

describe('HazelRecordingMonitorService', () => {
  let service: HazelRecordingMonitorService;
  let recordingRepository: jest.Mocked<Partial<RecordingRepository>>;
  let cloudRecordingService: jest.Mocked<Partial<AgoraCloudRecordingService>>;
  let finalizer: jest.Mocked<Partial<HazelRecordingFinalizerService>>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    recordingRepository = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
    };
    cloudRecordingService = {
      query: jest.fn(),
    };
    finalizer = {
      finalize: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    service = new HazelRecordingMonitorService(
      recordingRepository as any,
      cloudRecordingService as any,
      finalizer as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('no-op when no pending recordings', async () => {
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([]),
    );

    await service.checkPendingHazelRecordings();

    expect(cloudRecordingService.query).not.toHaveBeenCalled();
    expect(finalizer.finalize).not.toHaveBeenCalled();
    expect(finalizer.markFailed).not.toHaveBeenCalled();
  });

  it('orphan guard: createdAt past 6h → markFailed(orphan_timeout) without Agora query', async () => {
    const orphan = makeRecording({
      createdAt: new Date(Date.now() - ORPHAN_AGE_MS),
    });
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([orphan]),
    );

    await service.checkPendingHazelRecordings();

    expect(finalizer.markFailed).toHaveBeenCalledWith(orphan, 'orphan_timeout');
    expect(cloudRecordingService.query).not.toHaveBeenCalled();
  });

  it('Agora status 7 (stopped) → re-fetch + finalize(monitor_detected_stopped)', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    (cloudRecordingService.query as jest.Mock).mockResolvedValue({
      serverResponse: { status: 7 },
    });
    const fresh = { ...rec, status: RecordingStatus.RECORDING };
    (recordingRepository.findOne as jest.Mock).mockResolvedValue(fresh);

    await service.checkPendingHazelRecordings();

    expect(recordingRepository.findOne).toHaveBeenCalled();
    expect(finalizer.finalize).toHaveBeenCalledWith(
      fresh,
      'monitor_detected_stopped',
    );
  });

  it('Agora status 8 (exited) also triggers finalize', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    (cloudRecordingService.query as jest.Mock).mockResolvedValue({
      serverResponse: { status: 8 },
    });
    (recordingRepository.findOne as jest.Mock).mockResolvedValue(rec);

    await service.checkPendingHazelRecordings();

    expect(finalizer.finalize).toHaveBeenCalled();
  });

  it('race guard: re-fetch returns non-RECORDING status → skip finalize', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    (cloudRecordingService.query as jest.Mock).mockResolvedValue({
      serverResponse: { status: 7 },
    });
    (recordingRepository.findOne as jest.Mock).mockResolvedValue({
      ...rec,
      status: RecordingStatus.READY,
    });

    await service.checkPendingHazelRecordings();

    expect(finalizer.finalize).not.toHaveBeenCalled();
  });

  it('race guard: re-fetch returns null → skip finalize', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    (cloudRecordingService.query as jest.Mock).mockResolvedValue({
      serverResponse: { status: 7 },
    });
    (recordingRepository.findOne as jest.Mock).mockResolvedValue(null);

    await service.checkPendingHazelRecordings();

    expect(finalizer.finalize).not.toHaveBeenCalled();
  });

  it('Agora status 5 (recording normally) → no action', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    (cloudRecordingService.query as jest.Mock).mockResolvedValue({
      serverResponse: { status: 5 },
    });

    await service.checkPendingHazelRecordings();

    expect(finalizer.finalize).not.toHaveBeenCalled();
    expect(finalizer.markFailed).not.toHaveBeenCalled();
  });

  it('Agora 400 (resource lost) → markFailed(agora_resource_lost)', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    const err: any = new Error('Bad Request');
    err.response = { status: 400 };
    (cloudRecordingService.query as jest.Mock).mockRejectedValue(err);

    await service.checkPendingHazelRecordings();

    expect(finalizer.markFailed).toHaveBeenCalledWith(
      rec,
      'agora_resource_lost',
    );
  });

  it('non-400 Agora error → log only, no state change', async () => {
    const rec = makeRecording();
    (recordingRepository.createQueryBuilder as jest.Mock).mockReturnValue(
      makeBuilder([rec]),
    );
    const err: any = new Error('5xx');
    err.response = { status: 503 };
    (cloudRecordingService.query as jest.Mock).mockRejectedValue(err);

    await service.checkPendingHazelRecordings();

    expect(finalizer.markFailed).not.toHaveBeenCalled();
    expect(finalizer.finalize).not.toHaveBeenCalled();
  });
});
