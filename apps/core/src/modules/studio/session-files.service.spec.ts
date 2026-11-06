/** biome-ignore-all lint/suspicious/noExplicitAny: test doubles are partial */
import {
  BookingRepository,
  MediaService,
  RehearsalMode,
  RehearsalStatus,
  RehersalRepository,
  SESSION_FILE_EVENTS,
  SessionSharedFile,
  SessionSharedFileAnalysisStatus,
  SessionSharedFileRepository,
  StorageService,
} from '@app/common';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RehearsalLifecycleEventService } from '../rehearsal/rehearsal-lifecycle-event.service';
import { SessionFilesService } from './session-files.service';

const baseRehearsal = {
  id: 'rehearsal-1',
  bookingId: 'booking-1',
  mode: RehearsalMode.READER_BOOKED,
  status: RehearsalStatus.ACTIVE,
} as any;

const baseMedia = {
  id: 'media-1',
  userId: 'user-actor',
  s3Key: 'media/scripts/foo.pdf',
  fileName: 'foo.pdf',
  size: 12345,
  contentType: 'application/pdf',
  contentHash: 'hash-aaa',
} as any;

const makeRow = (over: Partial<SessionSharedFile> = {}): SessionSharedFile =>
  ({
    id: 'shared-1',
    rehearsalId: 'rehearsal-1',
    uploaderUserId: 'user-actor',
    fileName: 'foo.pdf',
    fileSize: 12345,
    mimeType: 'application/pdf',
    extension: 'pdf',
    s3Key: 'media/scripts/foo.pdf',
    contentHash: 'hash-aaa',
    analysisStatus: SessionSharedFileAnalysisStatus.NONE,
    analysisResult: null,
    analysisError: null,
    analysisRequestedBy: null,
    analysisRequestedAt: null,
    analysisCompletedAt: null,
    clientUploadId: 'client-1',
    createdAt: new Date('2026-05-01T10:00:00Z'),
    updatedAt: new Date('2026-05-01T10:00:00Z'),
    ...over,
  }) as SessionSharedFile;

describe('SessionFilesService', () => {
  let sharedFilesRepo: jest.Mocked<Partial<SessionSharedFileRepository>>;
  let rehearsalRepo: jest.Mocked<Partial<RehersalRepository>>;
  let bookingRepo: jest.Mocked<Partial<BookingRepository>>;
  let mediaService: jest.Mocked<Partial<MediaService>>;
  let storageService: jest.Mocked<Partial<StorageService>>;
  let lifecycleEvents: jest.Mocked<Partial<RehearsalLifecycleEventService>>;
  let notificationsClient: { emit: jest.Mock };
  let aiClient: { emit: jest.Mock };
  let service: SessionFilesService;

  beforeEach(() => {
    sharedFilesRepo = {
      findByClientUploadId: jest.fn().mockResolvedValue(null),
      countActiveByRehearsalId: jest.fn().mockResolvedValue(0),
      createEntity: jest.fn(),
      findActiveByRehearsalId: jest.fn().mockResolvedValue([]),
      findActiveById: jest.fn(),
      findCompletedAnalysisByHash: jest.fn().mockResolvedValue(null),
      softRemoveById: jest.fn(),
      updateById: jest.fn(),
      softDeleteAllByRehearsalId: jest.fn().mockResolvedValue(0),
    };
    rehearsalRepo = {
      findById: jest.fn().mockResolvedValue(baseRehearsal),
    };
    bookingRepo = {
      isParticipantOfRehearsal: jest.fn().mockResolvedValue(true),
    };
    mediaService = {
      findById: jest.fn().mockResolvedValue(baseMedia),
    };
    storageService = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue({
        url: 'https://signed/url',
        expiresInSeconds: 900,
        expiresAt: new Date('2026-05-01T10:15:00Z').toISOString(),
      }),
    };
    lifecycleEvents = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    notificationsClient = { emit: jest.fn() };
    aiClient = { emit: jest.fn() };

    service = new SessionFilesService(
      sharedFilesRepo as any,
      rehearsalRepo as any,
      bookingRepo as any,
      mediaService as any,
      storageService as any,
      lifecycleEvents as any,
      notificationsClient as any,
      aiClient as any,
    );
  });

  describe('attach', () => {
    it('persists row and emits SHARED event on happy path', async () => {
      (sharedFilesRepo.createEntity as jest.Mock).mockResolvedValue(makeRow());

      const res = await service.attach('rehearsal-1', 'user-actor', {
        fileId: 'media-1',
        clientUploadId: 'client-1',
      });

      expect(res.id).toBe('shared-1');
      expect(res.downloadUrl).toBe('https://signed/url');
      expect(sharedFilesRepo.createEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          rehearsalId: 'rehearsal-1',
          uploaderUserId: 'user-actor',
          fileName: 'foo.pdf',
          extension: 'pdf',
          contentHash: 'hash-aaa',
          clientUploadId: 'client-1',
        }),
      );
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        SESSION_FILE_EVENTS.SHARED,
        expect.objectContaining({ bookingId: 'booking-1' }),
      );
    });

    it('rejects non-participant with 403', async () => {
      (bookingRepo.isParticipantOfRehearsal as jest.Mock).mockResolvedValue(
        false,
      );
      await expect(
        service.attach('rehearsal-1', 'user-outsider', {
          fileId: 'media-1',
          clientUploadId: 'client-1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sharedFilesRepo.createEntity).not.toHaveBeenCalled();
    });

    it('rejects when rehearsal not ACTIVE', async () => {
      (rehearsalRepo.findById as jest.Mock).mockResolvedValue({
        ...baseRehearsal,
        status: RehearsalStatus.PAUSED,
      });
      await expect(
        service.attach('rehearsal-1', 'user-actor', {
          fileId: 'media-1',
          clientUploadId: 'client-1',
        }),
      ).rejects.toMatchObject({ response: { code: 'SESSION_NOT_ACTIVE' } });
    });

    it('rejects past the per-session cap', async () => {
      (sharedFilesRepo.countActiveByRehearsalId as jest.Mock).mockResolvedValue(
        20,
      );
      await expect(
        service.attach('rehearsal-1', 'user-actor', {
          fileId: 'media-1',
          clientUploadId: 'client-1',
        }),
      ).rejects.toMatchObject({ response: { code: 'RATE_LIMIT_EXCEEDED' } });
    });

    it('returns existing row for repeat clientUploadId (idempotent)', async () => {
      const existing = makeRow({ id: 'shared-existing' });
      (sharedFilesRepo.findByClientUploadId as jest.Mock).mockResolvedValue(
        existing,
      );

      const res = await service.attach('rehearsal-1', 'user-actor', {
        fileId: 'media-1',
        clientUploadId: 'client-1',
      });

      expect(res.id).toBe('shared-existing');
      expect(sharedFilesRepo.createEntity).not.toHaveBeenCalled();
      expect(notificationsClient.emit).not.toHaveBeenCalled();
    });

    it('rejects sharing a file uploaded by a different user', async () => {
      (mediaService.findById as jest.Mock).mockResolvedValue({
        ...baseMedia,
        userId: 'someone-else',
      });
      await expect(
        service.attach('rehearsal-1', 'user-actor', {
          fileId: 'media-1',
          clientUploadId: 'client-1',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('softDelete', () => {
    it('rejects when caller is not the uploader', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow(),
      );
      (bookingRepo.isParticipantOfRehearsal as jest.Mock).mockResolvedValue(
        true,
      );

      await expect(
        service.softDelete('rehearsal-1', 'shared-1', 'user-reader'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sharedFilesRepo.softRemoveById).not.toHaveBeenCalled();
    });

    it('soft-removes and emits DELETED for uploader', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow(),
      );

      await service.softDelete('rehearsal-1', 'shared-1', 'user-actor');

      expect(sharedFilesRepo.softRemoveById).toHaveBeenCalledWith('shared-1');
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        SESSION_FILE_EVENTS.DELETED,
        expect.objectContaining({
          sharedFileId: 'shared-1',
          deletedBy: 'user-actor',
          bookingId: 'booking-1',
        }),
      );
    });
  });

  describe('analyze', () => {
    it('short-circuits with cached result and emits ANALYZED', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow(),
      );
      (
        sharedFilesRepo.findCompletedAnalysisByHash as jest.Mock
      ).mockResolvedValue(
        makeRow({
          id: 'shared-prior',
          analysisStatus: SessionSharedFileAnalysisStatus.COMPLETED,
          analysisResult: { scenes: ['parsed'] },
        }),
      );

      const res = await service.analyze(
        'rehearsal-1',
        'shared-1',
        'user-actor',
      );

      expect(res.status).toBe('cached');
      expect(res.result).toEqual({ scenes: ['parsed'] });
      expect(sharedFilesRepo.updateById).toHaveBeenCalledWith(
        'shared-1',
        expect.objectContaining({
          analysisStatus: SessionSharedFileAnalysisStatus.CACHED,
        }),
      );
      expect(aiClient.emit).not.toHaveBeenCalled();
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        SESSION_FILE_EVENTS.ANALYZED,
        expect.objectContaining({ status: 'cached' }),
      );
    });

    it('dispatches parser job + ANALYZING event on cache miss', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow(),
      );

      const res = await service.analyze(
        'rehearsal-1',
        'shared-1',
        'user-actor',
      );

      expect(res.status).toBe('pending');
      expect(sharedFilesRepo.updateById).toHaveBeenCalledWith(
        'shared-1',
        expect.objectContaining({
          analysisStatus: SessionSharedFileAnalysisStatus.PENDING,
        }),
      );
      expect(aiClient.emit).toHaveBeenCalledWith(
        SESSION_FILE_EVENTS.ANALYSIS_REQUESTED,
        expect.objectContaining({ sharedFileId: 'shared-1' }),
      );
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        SESSION_FILE_EVENTS.ANALYZING,
        expect.objectContaining({ sharedFileId: 'shared-1' }),
      );
    });
  });

  describe('list', () => {
    it('returns active rows with freshly signed download URLs', async () => {
      (sharedFilesRepo.findActiveByRehearsalId as jest.Mock).mockResolvedValue([
        makeRow(),
        makeRow({ id: 'shared-2' }),
      ]);

      const res = await service.list('rehearsal-1', 'user-actor');

      expect(res).toHaveLength(2);
      expect(res[0].downloadUrl).toBe('https://signed/url');
      expect(storageService.getSignedDownloadUrl).toHaveBeenCalledTimes(2);
    });

    it('rejects non-participant', async () => {
      (bookingRepo.isParticipantOfRehearsal as jest.Mock).mockResolvedValue(
        false,
      );
      await expect(
        service.list('rehearsal-1', 'user-x'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('markAllDeletedOnSessionEnd', () => {
    it('bulk soft-deletes all rows for the rehearsal', async () => {
      (
        sharedFilesRepo.softDeleteAllByRehearsalId as jest.Mock
      ).mockResolvedValue(3);

      const affected = await service.markAllDeletedOnSessionEnd('rehearsal-1');

      expect(affected).toBe(3);
      expect(sharedFilesRepo.softDeleteAllByRehearsalId).toHaveBeenCalledWith(
        'rehearsal-1',
      );
    });
  });

  describe('handleAnalysisResult', () => {
    it('writes completed result + fans out ANALYZED', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow({
          analysisStatus: SessionSharedFileAnalysisStatus.PROCESSING,
          analysisRequestedAt: new Date('2026-05-01T09:59:00Z'),
        }),
      );

      await service.handleAnalysisResult({
        pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
        rehearsalId: 'rehearsal-1',
        sharedFileId: 'shared-1',
        status: 'completed',
        result: { scenes: ['ok'] },
        completedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
      } as any);

      expect(sharedFilesRepo.updateById).toHaveBeenCalledWith(
        'shared-1',
        expect.objectContaining({
          analysisStatus: SessionSharedFileAnalysisStatus.COMPLETED,
          analysisResult: { scenes: ['ok'] },
        }),
      );
      expect(notificationsClient.emit).toHaveBeenCalledWith(
        SESSION_FILE_EVENTS.ANALYZED,
        expect.objectContaining({
          status: 'completed',
          bookingId: 'booking-1',
        }),
      );
    });

    it('writes failed status + error on failure', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow(),
      );

      await service.handleAnalysisResult({
        pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
        rehearsalId: 'rehearsal-1',
        sharedFileId: 'shared-1',
        status: 'failed',
        error: 'PARSE_ERROR',
        completedAt: new Date('2026-05-01T10:00:00Z').toISOString(),
      } as any);

      expect(sharedFilesRepo.updateById).toHaveBeenCalledWith(
        'shared-1',
        expect.objectContaining({
          analysisStatus: SessionSharedFileAnalysisStatus.FAILED,
          analysisError: 'PARSE_ERROR',
        }),
      );
    });

    it('no-ops when the row is missing', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(null);

      await service.handleAnalysisResult({
        pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
        rehearsalId: 'rehearsal-1',
        sharedFileId: 'gone',
        status: 'completed',
        result: {},
        completedAt: new Date().toISOString(),
      } as any);

      expect(sharedFilesRepo.updateById).not.toHaveBeenCalled();
      expect(notificationsClient.emit).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('rejects when shared file is from a different rehearsal', async () => {
      (sharedFilesRepo.findActiveById as jest.Mock).mockResolvedValue(
        makeRow({ rehearsalId: 'rehearsal-other' }),
      );
      await expect(
        service.get('rehearsal-1', 'shared-1', 'user-actor'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
