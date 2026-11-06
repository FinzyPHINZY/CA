/** biome-ignore-all lint/suspicious/noExplicitAny: integration-style test */
// End-to-end-ish lifecycle test: attach → list (both participants) → analyze
// (cache miss → result delivered via consumer) → delete → session-end
// soft-delete. Boots controller + service + consumer wired via Nest Testing
// module, with repos / clients / storage all swapped for in-memory fakes.

import {
  AI_SERVICE,
  BookingRepository,
  JwtAuthGuard,
  MediaService,
  NOTIFICATIONS_SERVICE,
  RehearsalMode,
  RehearsalStatus,
  RehersalRepository,
  SESSION_FILE_EVENTS,
  SessionSharedFile,
  SessionSharedFileAnalysisStatus,
  SessionSharedFileRepository,
  StorageService,
} from '@app/common';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import * as request from 'supertest';
import { RehearsalLifecycleEventService } from '../rehearsal/rehearsal-lifecycle-event.service';
import { SessionFilesConsumer } from './session-files.consumer';
import { SessionFilesController } from './session-files.controller';
import { SessionFilesService } from './session-files.service';

class FakeSharedFilesRepo {
  rows = new Map<string, SessionSharedFile>();

  async findActiveById(id: string) {
    const row = this.rows.get(id);
    return row && !row.deletedAt ? row : null;
  }
  async findActiveByRehearsalId(rehearsalId: string) {
    return Array.from(this.rows.values()).filter(
      (r) => r.rehearsalId === rehearsalId && !r.deletedAt,
    );
  }
  async countActiveByRehearsalId(rehearsalId: string) {
    return (await this.findActiveByRehearsalId(rehearsalId)).length;
  }
  async findByClientUploadId(
    rehearsalId: string,
    userId: string,
    clientUploadId: string,
  ) {
    return (
      Array.from(this.rows.values()).find(
        (r) =>
          r.rehearsalId === rehearsalId &&
          r.uploaderUserId === userId &&
          r.clientUploadId === clientUploadId &&
          !r.deletedAt,
      ) ?? null
    );
  }
  async createEntity(data: Partial<SessionSharedFile>) {
    const id = randomUUID();
    const row: SessionSharedFile = {
      id,
      analysisStatus: SessionSharedFileAnalysisStatus.NONE,
      analysisResult: null,
      analysisError: null,
      analysisRequestedBy: null,
      analysisRequestedAt: null,
      analysisCompletedAt: null,
      createdAt: new Date('2026-05-01T10:00:00Z'),
      updatedAt: new Date('2026-05-01T10:00:00Z'),
      ...(data as any),
    } as SessionSharedFile;
    this.rows.set(id, row);
    return row;
  }
  async findCompletedAnalysisByHash(hash: string) {
    return (
      Array.from(this.rows.values()).find(
        (r) =>
          r.contentHash === hash &&
          r.analysisStatus === SessionSharedFileAnalysisStatus.COMPLETED,
      ) ?? null
    );
  }
  async updateById(id: string, patch: Partial<SessionSharedFile>) {
    const row = this.rows.get(id);
    if (!row) return { affected: 0 };
    Object.assign(row, patch);
    return { affected: 1 };
  }
  async softRemoveById(id: string) {
    const row = this.rows.get(id);
    if (row) row.deletedAt = new Date();
  }
  async softDeleteAllByRehearsalId(rehearsalId: string) {
    let n = 0;
    for (const row of this.rows.values()) {
      if (row.rehearsalId === rehearsalId && !row.deletedAt) {
        row.deletedAt = new Date();
        n++;
      }
    }
    return n;
  }
}

const ACTOR_USER = '91e50219-127e-40db-aa18-7a96a8b9146d';
const READER_USER = 'e523a820-764d-4c41-9579-9de58b7cc7b8';
const REHEARSAL_ID = '5789980b-1403-4724-b3aa-7fcb20a9e84d';
const BOOKING_ID = '3f6cc85a-88b4-4a89-aed5-c97318338a13';
const MEDIA_ID_A = '2204637c-1beb-47d6-a7fc-11fb556d9480';
const CLIENT_UPLOAD_ID_A = '6f066323-bdbb-465d-81dc-7621d779d34f';
const CLIENT_UPLOAD_ID_B = '5f69da92-6147-4024-a66a-16fac6a4ddec';

describe('SessionFiles lifecycle (integration)', () => {
  let app: INestApplication;
  let sharedFilesRepo: FakeSharedFilesRepo;
  let aiClient: { emit: jest.Mock };
  let notificationsClient: { emit: jest.Mock };
  let consumer: SessionFilesConsumer;
  // current authenticated user (mutated per request to simulate different participants)
  let currentUserId = ACTOR_USER;

  beforeAll(async () => {
    sharedFilesRepo = new FakeSharedFilesRepo();
    aiClient = { emit: jest.fn() };
    notificationsClient = { emit: jest.fn() };

    const rehearsal = {
      id: REHEARSAL_ID,
      bookingId: BOOKING_ID,
      mode: RehearsalMode.READER_BOOKED,
      status: RehearsalStatus.ACTIVE,
    };

    const media = {
      id: MEDIA_ID_A,
      userId: ACTOR_USER,
      s3Key: 'media/scripts/foo.pdf',
      fileName: 'audition-sides.pdf',
      size: 184320,
      contentType: 'application/pdf',
      contentHash: 'sha256-hash-A',
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SessionFilesController, SessionFilesConsumer],
      providers: [
        SessionFilesService,
        { provide: SessionSharedFileRepository, useValue: sharedFilesRepo },
        {
          provide: RehersalRepository,
          useValue: {
            findById: jest.fn().mockResolvedValue(rehearsal),
            findByBookingId: jest.fn().mockResolvedValue(rehearsal),
          },
        },
        {
          provide: BookingRepository,
          useValue: {
            isParticipantOfRehearsal: jest
              .fn()
              .mockImplementation(async (_r: string, userId: string) =>
                [ACTOR_USER, READER_USER].includes(userId),
              ),
          },
        },
        {
          provide: MediaService,
          useValue: {
            findById: jest.fn().mockResolvedValue(media),
          },
        },
        {
          provide: StorageService,
          useValue: {
            getSignedDownloadUrl: jest.fn().mockResolvedValue({
              url: 'https://signed/url',
              expiresInSeconds: 900,
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
            }),
            deleteObject: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RehearsalLifecycleEventService,
          useValue: { log: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NOTIFICATIONS_SERVICE, useValue: notificationsClient },
        { provide: AI_SERVICE, useValue: aiClient },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: currentUserId };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();

    consumer = moduleRef.get(SessionFilesConsumer);
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs through attach → list (both participants) → analyze → result → delete → session-end cleanup', async () => {
    // 1. Actor attaches.
    currentUserId = ACTOR_USER;
    const attachRes = await request(app.getHttpServer())
      .post(`/rehearsals/${REHEARSAL_ID}/shared-files`)
      .send({ fileId: MEDIA_ID_A, clientUploadId: CLIENT_UPLOAD_ID_A })
      .expect(201);
    expect(attachRes.body.uploaderUserId).toBe(ACTOR_USER);
    const sharedFileId = attachRes.body.id;

    expect(notificationsClient.emit).toHaveBeenCalledWith(
      SESSION_FILE_EVENTS.SHARED,
      expect.objectContaining({
        sharedFileId,
        bookingId: BOOKING_ID,
      }),
    );

    // 2. Reader lists — sees the same file.
    currentUserId = READER_USER;
    const listAsReader = await request(app.getHttpServer())
      .get(`/rehearsals/${REHEARSAL_ID}/shared-files`)
      .expect(200);
    expect(listAsReader.body).toHaveLength(1);
    expect(listAsReader.body[0].id).toBe(sharedFileId);
    expect(listAsReader.body[0].downloadUrl).toMatch(/^https:\/\/signed/);

    // 3. Reader triggers analyze — cache miss → pending + ai_service dispatch.
    const analyzeRes = await request(app.getHttpServer())
      .post(`/rehearsals/${REHEARSAL_ID}/shared-files/${sharedFileId}/analyze`)
      .expect(202);
    expect(analyzeRes.body.status).toBe('pending');
    expect(aiClient.emit).toHaveBeenCalledWith(
      SESSION_FILE_EVENTS.ANALYSIS_REQUESTED,
      expect.objectContaining({ sharedFileId }),
    );

    // 4. ai_service publishes result → consumer reconciles row.
    await consumer.handleAnalysisResult(
      {
        pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
        rehearsalId: REHEARSAL_ID,
        sharedFileId,
        status: 'completed',
        result: { title: 'Mock parse', scenes: [{ heading: 'INT.' }] },
        completedAt: new Date().toISOString(),
      } as any,
      {
        getChannelRef: () => ({ ack: jest.fn(), nack: jest.fn() }),
        getMessage: () => ({}),
      } as any,
    );

    // 5. Poll analysis endpoint → completed.
    const analysisRes = await request(app.getHttpServer())
      .get(`/rehearsals/${REHEARSAL_ID}/shared-files/${sharedFileId}/analysis`)
      .expect(200);
    expect(analysisRes.body.status).toBe('completed');
    expect(analysisRes.body.result).toEqual({
      title: 'Mock parse',
      scenes: [{ heading: 'INT.' }],
    });

    // 6. Reader cannot delete actor's file (uploader-only).
    await request(app.getHttpServer())
      .delete(`/rehearsals/${REHEARSAL_ID}/shared-files/${sharedFileId}`)
      .expect(403);

    // 7. Actor deletes.
    currentUserId = ACTOR_USER;
    await request(app.getHttpServer())
      .delete(`/rehearsals/${REHEARSAL_ID}/shared-files/${sharedFileId}`)
      .expect(204);

    // 8. List now empty.
    const listAfterDelete = await request(app.getHttpServer())
      .get(`/rehearsals/${REHEARSAL_ID}/shared-files`)
      .expect(200);
    expect(listAfterDelete.body).toHaveLength(0);

    // 9. Session-end cleanup is idempotent (nothing left to soft-delete).
    const service = (app as any).get(
      SessionFilesService,
    ) as SessionFilesService;
    const affected = await service.markAllDeletedOnSessionEnd(REHEARSAL_ID);
    expect(affected).toBe(0);
  });

  it('returns existing row on repeat clientUploadId (idempotent attach)', async () => {
    currentUserId = ACTOR_USER;
    const idempotentClientUploadId = CLIENT_UPLOAD_ID_B;

    const first = await request(app.getHttpServer())
      .post(`/rehearsals/${REHEARSAL_ID}/shared-files`)
      .send({
        fileId: MEDIA_ID_A,
        clientUploadId: idempotentClientUploadId,
      })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post(`/rehearsals/${REHEARSAL_ID}/shared-files`)
      .send({
        fileId: MEDIA_ID_A,
        clientUploadId: idempotentClientUploadId,
      })
      .expect(201);

    expect(first.body.id).toBe(second.body.id);
  });
});
