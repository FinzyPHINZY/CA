// SessionFilesService — side-channel doc sharing inside booked reader sessions.
//
// Two-step upload: FE first uploads to file_service (validation + S3), gets a
// fileId. Then calls POST /shared-files with that fileId — this service
// validates the participant, links the Media to the rehearsal, and fans out a
// SHARED socket event. Pure side-channel: no impact on rehearsal/turn state.
//
// Files live until session end. SessionService.completeSession bulk-soft-deletes
// the row set; SessionFilesRetentionService hard-deletes (S3 + DB) 24h later.

import {
  AI_SERVICE,
  AttachSharedFileDto,
  BookingRepository,
  MediaService,
  NOTIFICATIONS_SERVICE,
  RehearsalEventType,
  RehearsalMode,
  RehearsalStatus,
  Rehersal,
  RehersalRepository,
  SESSION_FILE_EVENTS,
  type SessionFileAnalysisRequestedEvent,
  type SessionFileAnalysisResultEvent,
  type SessionFileAnalyzedEvent,
  type SessionFileAnalyzingEvent,
  type SessionFileDeletedEvent,
  type SessionFileSharedEvent,
  SessionSharedFile,
  SessionSharedFileAnalysisStatus,
  SessionSharedFileRepository,
  type SharedFileAnalysisDto,
  type SharedFileResponseDto,
  StorageService,
} from '@app/common';
import { RehearsalLifecycleEventService } from '../rehearsal/rehearsal-lifecycle-event.service';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

const MAX_FILES_PER_SESSION = 20;
const PRESIGNED_URL_TTL_SECONDS = 900; // 15 minutes

@Injectable()
export class SessionFilesService {
  private readonly logger = new Logger(SessionFilesService.name);

  constructor(
    private readonly sharedFilesRepo: SessionSharedFileRepository,
    private readonly rehearsalRepo: RehersalRepository,
    private readonly bookingRepo: BookingRepository,
    private readonly mediaService: MediaService,
    private readonly storageService: StorageService,
    private readonly lifecycleEvents: RehearsalLifecycleEventService,
    @Inject(NOTIFICATIONS_SERVICE)
    private readonly notificationsClient: ClientProxy,
    @Inject(AI_SERVICE) private readonly aiClient: ClientProxy,
  ) {}

  // ── Public API ───────────────────────────────────────────────────────────

  async attach(
    rehearsalId: string,
    userId: string,
    dto: AttachSharedFileDto,
  ): Promise<SharedFileResponseDto> {
    const rehearsal = await this.assertParticipantAndActive(
      rehearsalId,
      userId,
    );

    // Idempotency short-circuit. Same (rehearsal, uploader, clientUploadId)
    // ALWAYS returns the existing row — FE retries are free.
    const existing = await this.sharedFilesRepo.findByClientUploadId(
      rehearsalId,
      userId,
      dto.clientUploadId,
    );
    if (existing) {
      return this.toResponseDto(existing);
    }

    const activeCount =
      await this.sharedFilesRepo.countActiveByRehearsalId(rehearsalId);
    if (activeCount >= MAX_FILES_PER_SESSION) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Per-session file cap reached (${MAX_FILES_PER_SESSION}). Delete a file before sharing another.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const media = await this.mediaService
      .findById(dto.fileId)
      .catch(() => null);
    if (!media) {
      throw new NotFoundException(
        `Uploaded file ${dto.fileId} not found — upload it via /files/upload first.`,
      );
    }
    if (media.userId !== userId) {
      throw new ForbiddenException(
        'You may only share files you uploaded yourself.',
      );
    }
    if (!media.s3Key) {
      throw new BadRequestException(
        'Uploaded file is missing an S3 reference and cannot be shared.',
      );
    }
    if (!media.contentHash) {
      // Backwards-compatible guard: any file uploaded after migration 066 will
      // have this. Older media may not — those can't take advantage of cache.
      this.logger.warn(
        `Media ${media.id} has no contentHash — analysis cache lookup will miss for this file.`,
      );
    }

    const fileName = (dto.fileName ?? media.fileName ?? 'document').trim();
    const extension = this.extractExtension(fileName);

    const saved = await this.sharedFilesRepo.createEntity({
      rehearsalId,
      uploaderUserId: userId,
      fileName,
      fileSize: Number(media.size ?? 0),
      mimeType: media.contentType ?? 'application/octet-stream',
      extension,
      s3Key: media.s3Key,
      contentHash: media.contentHash ?? '',
      analysisStatus: SessionSharedFileAnalysisStatus.NONE,
      clientUploadId: dto.clientUploadId,
    });

    const payload: SessionFileSharedEvent = {
      pattern: SESSION_FILE_EVENTS.SHARED,
      rehearsalId,
      bookingId: this.requireBookingId(rehearsal),
      sharedFileId: saved.id,
      uploaderUserId: userId,
      fileName: saved.fileName,
      fileSize: saved.fileSize,
      mimeType: saved.mimeType,
      uploadedAt: saved.createdAt.toISOString(),
    };
    this.notificationsClient.emit(SESSION_FILE_EVENTS.SHARED, payload);

    await this.lifecycleEvents
      .log(rehearsalId, RehearsalEventType.SHARED_FILE_ATTACHED, {
        data: {
          sharedFileId: saved.id,
          uploaderUserId: userId,
          fileName: saved.fileName,
          extension,
          fileSize: saved.fileSize,
        },
      })
      .catch((err: any) =>
        this.logger.warn(
          `Audit log SHARED_FILE_ATTACHED failed for ${saved.id}: ${err?.message ?? err}`,
        ),
      );

    this.logger.log(
      `Shared file attached: rehearsal=${rehearsalId} sharedFile=${saved.id} uploader=${userId} ext=${extension}`,
    );

    return this.toResponseDto(saved);
  }

  async list(
    rehearsalId: string,
    userId: string,
  ): Promise<SharedFileResponseDto[]> {
    await this.assertParticipant(rehearsalId, userId);
    const rows =
      await this.sharedFilesRepo.findActiveByRehearsalId(rehearsalId);
    return Promise.all(rows.map((row) => this.toResponseDto(row)));
  }

  async get(
    rehearsalId: string,
    fileId: string,
    userId: string,
  ): Promise<SharedFileResponseDto> {
    await this.assertParticipant(rehearsalId, userId);
    const row = await this.loadActiveOrFail(rehearsalId, fileId);
    return this.toResponseDto(row);
  }

  async softDelete(
    rehearsalId: string,
    fileId: string,
    userId: string,
  ): Promise<void> {
    await this.assertParticipant(rehearsalId, userId);
    const row = await this.loadActiveOrFail(rehearsalId, fileId);
    if (row.uploaderUserId !== userId) {
      throw new ForbiddenException(
        'Only the uploader can delete a shared file.',
      );
    }

    const rehearsal = await this.rehearsalRepo.findById(rehearsalId);
    await this.sharedFilesRepo.softRemoveById(row.id);

    const payload: SessionFileDeletedEvent = {
      pattern: SESSION_FILE_EVENTS.DELETED,
      rehearsalId,
      bookingId: this.requireBookingId(rehearsal),
      sharedFileId: row.id,
      deletedBy: userId,
    };
    this.notificationsClient.emit(SESSION_FILE_EVENTS.DELETED, payload);

    await this.lifecycleEvents
      .log(rehearsalId, RehearsalEventType.SHARED_FILE_DELETED, {
        data: {
          sharedFileId: row.id,
          deletedBy: userId,
          fileName: row.fileName,
        },
      })
      .catch((err: any) =>
        this.logger.warn(
          `Audit log SHARED_FILE_DELETED failed for ${row.id}: ${err?.message ?? err}`,
        ),
      );

    this.logger.log(
      `Shared file deleted: rehearsal=${rehearsalId} sharedFile=${row.id} deletedBy=${userId}`,
    );
  }

  async analyze(
    rehearsalId: string,
    fileId: string,
    userId: string,
  ): Promise<{
    sharedFileId: string;
    status: 'pending' | 'processing' | 'completed' | 'cached';
    result?: Record<string, any>;
  }> {
    const rehearsal = await this.assertParticipantAndActive(
      rehearsalId,
      userId,
    );
    const bookingId = this.requireBookingId(rehearsal);
    const row = await this.loadActiveOrFail(rehearsalId, fileId);

    // Already terminal — return current state instead of redispatching.
    if (
      row.analysisStatus === SessionSharedFileAnalysisStatus.COMPLETED ||
      row.analysisStatus === SessionSharedFileAnalysisStatus.CACHED
    ) {
      return {
        sharedFileId: row.id,
        status: row.analysisStatus,
        result: row.analysisResult ?? undefined,
      };
    }
    if (
      row.analysisStatus === SessionSharedFileAnalysisStatus.PENDING ||
      row.analysisStatus === SessionSharedFileAnalysisStatus.PROCESSING
    ) {
      return { sharedFileId: row.id, status: row.analysisStatus };
    }

    // Cross-session cache: if anyone has ever analyzed the same bytes (by
    // sha256), reuse their result. Free win on every shared script.
    if (row.contentHash) {
      const cached = await this.sharedFilesRepo.findCompletedAnalysisByHash(
        row.contentHash,
      );
      if (cached && cached.id !== row.id && cached.analysisResult) {
        const now = new Date();
        await this.sharedFilesRepo.updateById(row.id, {
          analysisStatus: SessionSharedFileAnalysisStatus.CACHED,
          analysisResult: cached.analysisResult,
          analysisRequestedBy: userId,
          analysisRequestedAt: now,
          analysisCompletedAt: now,
        });

        const payload: SessionFileAnalyzedEvent = {
          pattern: SESSION_FILE_EVENTS.ANALYZED,
          rehearsalId,
          bookingId,
          sharedFileId: row.id,
          status: 'cached',
        };
        this.notificationsClient.emit(SESSION_FILE_EVENTS.ANALYZED, payload);

        this.logger.log(
          `Shared file analysis cache hit: rehearsal=${rehearsalId} sharedFile=${row.id} reusedFrom=${cached.id}`,
        );

        return {
          sharedFileId: row.id,
          status: 'cached',
          result: cached.analysisResult,
        };
      }
    }

    // Cache miss → dispatch to ai_service for parser+analysis.
    await this.sharedFilesRepo.updateById(row.id, {
      analysisStatus: SessionSharedFileAnalysisStatus.PENDING,
      analysisResult: null,
      analysisError: null,
      analysisRequestedBy: userId,
      analysisRequestedAt: new Date(),
      analysisCompletedAt: null,
    });

    const request: SessionFileAnalysisRequestedEvent = {
      pattern: SESSION_FILE_EVENTS.ANALYSIS_REQUESTED,
      rehearsalId,
      sharedFileId: row.id,
      requestedBy: userId,
      s3Key: row.s3Key,
      fileName: row.fileName,
      extension: row.extension,
      mimeType: row.mimeType,
      contentHash: row.contentHash,
    };
    this.aiClient.emit(SESSION_FILE_EVENTS.ANALYSIS_REQUESTED, request);

    await this.lifecycleEvents
      .log(rehearsalId, RehearsalEventType.SHARED_FILE_ANALYZE_REQUESTED, {
        data: {
          sharedFileId: row.id,
          requestedBy: userId,
          fileName: row.fileName,
          extension: row.extension,
        },
      })
      .catch((err: any) =>
        this.logger.warn(
          `Audit log SHARED_FILE_ANALYZE_REQUESTED failed for ${row.id}: ${err?.message ?? err}`,
        ),
      );

    const fanout: SessionFileAnalyzingEvent = {
      pattern: SESSION_FILE_EVENTS.ANALYZING,
      rehearsalId,
      bookingId,
      sharedFileId: row.id,
      requestedBy: userId,
    };
    this.notificationsClient.emit(SESSION_FILE_EVENTS.ANALYZING, fanout);

    this.logger.log(
      `Shared file analysis dispatched: rehearsal=${rehearsalId} sharedFile=${row.id} requestedBy=${userId}`,
    );

    return { sharedFileId: row.id, status: 'pending' };
  }

  async getAnalysis(
    rehearsalId: string,
    fileId: string,
    userId: string,
  ): Promise<SharedFileAnalysisDto> {
    await this.assertParticipant(rehearsalId, userId);
    const row = await this.loadActiveOrFail(rehearsalId, fileId);
    return {
      sharedFileId: row.id,
      status: row.analysisStatus,
      result: row.analysisResult ?? null,
      error: row.analysisError ?? null,
      requestedBy: row.analysisRequestedBy ?? null,
      requestedAt: row.analysisRequestedAt?.toISOString() ?? null,
      completedAt: row.analysisCompletedAt?.toISOString() ?? null,
    };
  }

  // Called from the @EventPattern consumer when ai_service publishes
  // SESSION_FILE_EVENTS.ANALYSIS_RESULT. Writes the row and fans out the
  // ANALYZED socket event. No participant check — this is a service-to-service
  // message authenticated by transport.
  async handleAnalysisResult(
    event: SessionFileAnalysisResultEvent,
  ): Promise<void> {
    const row = await this.sharedFilesRepo.findActiveById(event.sharedFileId);
    if (!row || row.rehearsalId !== event.rehearsalId) {
      this.logger.warn(
        `Analysis result for unknown/mismatched shared file: ${event.sharedFileId}`,
      );
      return;
    }

    const rehearsal = await this.rehearsalRepo.findById(event.rehearsalId);
    if (!rehearsal?.bookingId) {
      this.logger.warn(
        `Analysis result for rehearsal without booking: ${event.rehearsalId}`,
      );
      return;
    }

    const completedAt = new Date(event.completedAt ?? Date.now());
    if (event.status === 'completed') {
      await this.sharedFilesRepo.updateById(row.id, {
        analysisStatus: SessionSharedFileAnalysisStatus.COMPLETED,
        analysisResult: event.result ?? null,
        analysisError: null,
        analysisCompletedAt: completedAt,
      });
    } else {
      await this.sharedFilesRepo.updateById(row.id, {
        analysisStatus: SessionSharedFileAnalysisStatus.FAILED,
        analysisResult: null,
        analysisError: event.error ?? 'Analysis failed',
        analysisCompletedAt: completedAt,
      });
    }

    const fanout: SessionFileAnalyzedEvent = {
      pattern: SESSION_FILE_EVENTS.ANALYZED,
      rehearsalId: event.rehearsalId,
      bookingId: rehearsal.bookingId,
      sharedFileId: event.sharedFileId,
      status: event.status,
      error: event.error,
    };
    this.notificationsClient.emit(SESSION_FILE_EVENTS.ANALYZED, fanout);

    const durationMs = row.analysisRequestedAt
      ? completedAt.getTime() - row.analysisRequestedAt.getTime()
      : null;

    const auditEventType =
      event.status === 'completed'
        ? RehearsalEventType.SHARED_FILE_ANALYZE_COMPLETED
        : RehearsalEventType.SHARED_FILE_ANALYZE_FAILED;
    await this.lifecycleEvents
      .log(event.rehearsalId, auditEventType, {
        data: {
          sharedFileId: event.sharedFileId,
          durationMs,
          error: event.error,
        },
      })
      .catch((err: any) =>
        this.logger.warn(
          `Audit log ${auditEventType} failed for ${event.sharedFileId}: ${err?.message ?? err}`,
        ),
      );

    this.logger.log(
      `Shared file analysis ${event.status}: rehearsal=${event.rehearsalId} sharedFile=${event.sharedFileId}${
        durationMs !== null ? ` durationMs=${durationMs}` : ''
      }`,
    );
  }

  // Called from SessionService.completeSession. Bulk soft-deletes every active
  // shared file for the rehearsal. Returns affected count for the caller's log.
  async markAllDeletedOnSessionEnd(rehearsalId: string): Promise<number> {
    const affected =
      await this.sharedFilesRepo.softDeleteAllByRehearsalId(rehearsalId);
    if (affected > 0) {
      this.logger.log(
        `Session-end cleanup: soft-deleted ${affected} shared files for rehearsal=${rehearsalId}`,
      );
    }
    return affected;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async assertParticipant(
    rehearsalId: string,
    userId: string,
  ): Promise<void> {
    const isParticipant = await this.bookingRepo.isParticipantOfRehearsal(
      rehearsalId,
      userId,
    );
    if (!isParticipant) {
      throw new ForbiddenException({
        code: 'NOT_PARTICIPANT',
        message: 'You are not a participant of this rehearsal session.',
      });
    }
  }

  private async assertParticipantAndActive(
    rehearsalId: string,
    userId: string,
  ): Promise<Rehersal> {
    await this.assertParticipant(rehearsalId, userId);
    const rehearsal = await this.rehearsalRepo.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal ${rehearsalId} not found`);
    }
    if (rehearsal.mode !== RehearsalMode.READER_BOOKED) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_REHEARSAL_MODE',
        message:
          'File sharing is only available in booked reader sessions (READER_BOOKED mode).',
      });
    }
    if (rehearsal.status !== RehearsalStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'SESSION_NOT_ACTIVE',
        message: `Files can only be shared while the session is ACTIVE (current status: ${rehearsal.status}).`,
      });
    }
    return rehearsal;
  }

  private requireBookingId(rehearsal: Rehersal | null | undefined): string {
    if (!rehearsal?.bookingId) {
      throw new BadRequestException({
        code: 'MISSING_BOOKING',
        message:
          'This rehearsal has no associated booking — shared files are only supported for booked reader sessions.',
      });
    }
    return rehearsal.bookingId;
  }

  private async loadActiveOrFail(
    rehearsalId: string,
    fileId: string,
  ): Promise<SessionSharedFile> {
    const row = await this.sharedFilesRepo.findActiveById(fileId);
    if (!row || row.rehearsalId !== rehearsalId) {
      throw new NotFoundException(
        `Shared file ${fileId} not found in this session`,
      );
    }
    return row;
  }

  private async toResponseDto(
    row: SessionSharedFile,
  ): Promise<SharedFileResponseDto> {
    const signed = await this.storageService.getSignedDownloadUrl(
      row.s3Key,
      PRESIGNED_URL_TTL_SECONDS,
    );
    return {
      id: row.id,
      rehearsalId: row.rehearsalId,
      uploaderUserId: row.uploaderUserId,
      fileName: row.fileName,
      fileSize: row.fileSize,
      mimeType: row.mimeType,
      extension: row.extension,
      contentHash: row.contentHash,
      downloadUrl: signed.url,
      downloadUrlExpiresAt: signed.expiresAt,
      analysisStatus: row.analysisStatus,
      analysisRequestedBy: row.analysisRequestedBy ?? null,
      analysisRequestedAt: row.analysisRequestedAt?.toISOString() ?? null,
      analysisCompletedAt: row.analysisCompletedAt?.toISOString() ?? null,
      uploadedAt: row.createdAt.toISOString(),
    };
  }

  private extractExtension(fileName: string): string {
    const idx = fileName.lastIndexOf('.');
    if (idx < 0 || idx === fileName.length - 1) return '';
    return fileName.slice(idx + 1).toLowerCase();
  }
}
