/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import {
  AgoraSession,
  Booking,
  Character,
  Recording,
  RehearsalMode,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Rehersal,
  Scene,
  UserRepository,
} from '@app/common';
import { DataSource } from 'typeorm';
import { RehearsalReadModelService } from './rehearsal-read-model.service';

function makeRepository() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
  };
}

describe('RehearsalReadModelService', () => {
  let service: RehearsalReadModelService;
  let bookingRepo: ReturnType<typeof makeRepository>;
  let agoraRepo: ReturnType<typeof makeRepository>;
  let sceneRepo: ReturnType<typeof makeRepository>;
  let characterRepo: ReturnType<typeof makeRepository>;
  let recordingRepo: ReturnType<typeof makeRepository>;
  let dataSource: Partial<DataSource>;
  let userRepository: Partial<UserRepository>;

  beforeEach(() => {
    bookingRepo = makeRepository();
    agoraRepo = makeRepository();
    sceneRepo = makeRepository();
    characterRepo = makeRepository();
    recordingRepo = makeRepository();
    userRepository = {
      findById: jest.fn().mockResolvedValue(null),
    };

    const repoMap = new Map<any, any>([
      [Booking, bookingRepo],
      [AgoraSession, agoraRepo],
      [Scene, sceneRepo],
      [Character, characterRepo],
      [Recording, recordingRepo],
    ]);

    dataSource = {
      getRepository: jest.fn((entity) => repoMap.get(entity)),
    };

    service = new RehearsalReadModelService(
      dataSource as unknown as DataSource,
      userRepository as unknown as UserRepository,
    );

    bookingRepo.find.mockResolvedValue([]);
    agoraRepo.find.mockResolvedValue([]);
    sceneRepo.findOne.mockResolvedValue(null);
    characterRepo.findOne.mockResolvedValue(null);
    characterRepo.find.mockResolvedValue([]);
    recordingRepo.find.mockResolvedValue([]);
  });

  it('should build AI rehearsal detail with setup and analytics summaries', async () => {
    const rehearsal = {
      id: 'reh-1',
      userId: 'actor-1',
      projectId: 'project-1',
      scriptId: 'script-1',
      sceneId: 'scene-1',
      bookingId: null,
      rehearsalPartnerType: 'AI',
      rehearsalPartnerAiName: 'Hazel',
      mode: RehearsalMode.AI,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      status: RehearsalStatus.CREATED,
      characterId: 'char-1',
      recordings: [],
      project: { id: 'project-1', title: 'Pilot' },
      script: { id: 'script-1', title: 'Episode 1' },
      scene: null,
      character: null,
      startedAt: null,
      endedAt: null,
      sessionDurationSeconds: null,
      createdAt: new Date('2026-03-13T08:55:00.000Z'),
      updatedAt: new Date('2026-03-13T09:00:00.000Z'),
      metaData: {
        analyticsComputedAt: '2026-03-14T09:00:00.000Z',
        analytics: {
          completionPct: 50,
          avgResponseTimeMs: 1200,
        },
      },
    } as unknown as Rehersal;

    sceneRepo.findOne.mockResolvedValue({
      id: 'scene-1',
      number: 12,
      heading: 'INT. STUDIO - NIGHT',
      dialogues: [{ id: 'dialogue-1' }],
      characters: [
        { id: 'char-1', name: 'MAYA' },
        { id: 'char-2', name: 'JONAH' },
      ],
    } as any);
    characterRepo.findOne.mockResolvedValue({
      id: 'char-1',
      name: 'MAYA',
    } as Character);
    characterRepo.find.mockResolvedValue([
      { id: 'char-1', name: 'MAYA', scriptId: 'script-1' },
      { id: 'char-2', name: 'JONAH', scriptId: 'script-1' },
    ] as Character[]);
    agoraRepo.findOne.mockResolvedValue(null);

    const result = await service.buildDetail(rehearsal);

    expect(result.mode).toBe(RehearsalMode.AI);
    expect(result.partner.displayName).toBe('Hazel');
    expect(result.setupState).toEqual(
      expect.objectContaining({
        contentReady: true,
        roleSelectionRequired: true,
        roleSelected: true,
        canPrepareRuntime: true,
        canStartRuntime: false,
        selectedCharacterId: 'char-1',
      }),
    );
    expect(result.analyticsSummary).toEqual({
      computedAt: '2026-03-14T09:00:00.000Z',
      completionPct: 50,
      avgResponseTimeMs: 1200,
    });
  });

  it('should expose canonical available character ids instead of stale scene ids', async () => {
    const rehearsal = {
      id: 'reh-1',
      userId: 'actor-1',
      projectId: 'project-1',
      scriptId: 'script-1',
      sceneId: 'scene-1',
      bookingId: null,
      rehearsalPartnerType: 'AI',
      rehearsalPartnerAiName: 'Hazel',
      mode: RehearsalMode.AI,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      status: RehearsalStatus.CREATED,
      characterId: null,
      recordings: [],
      project: { id: 'project-1', title: 'Pilot' },
      script: { id: 'script-1', title: 'Episode 1' },
      scene: null,
      character: null,
      startedAt: null,
      endedAt: null,
      sessionDurationSeconds: null,
      createdAt: new Date('2026-03-13T08:55:00.000Z'),
      updatedAt: new Date('2026-03-13T09:00:00.000Z'),
      metaData: {},
    } as unknown as Rehersal;

    sceneRepo.findOne.mockResolvedValue({
      id: 'scene-1',
      number: 12,
      heading: 'INT. STUDIO - NIGHT',
      dialogues: [{ id: 'dialogue-1', characterName: 'MAYA' }],
      characters: [{ id: 'scene-char-stale', name: 'MAYA' }],
    } as any);
    characterRepo.find.mockResolvedValue([
      { id: 'char-canonical', name: 'MAYA', scriptId: 'script-1' },
      { id: 'char-other', name: 'JONAH', scriptId: 'script-1' },
    ] as Character[]);

    const result = await service.buildDetail(rehearsal);

    expect(result.setupState.availableCharacterIds).toEqual(['char-canonical']);
  });

  it('should build list items with booking and runtime summaries', async () => {
    bookingRepo.find.mockResolvedValue([
      {
        id: 'booking-1',
        status: 'confirmed',
        readerProfileId: 'profile-1',
        sessionStartUtc: new Date('2026-03-20T14:00:00.000Z'),
        sessionEndUtc: new Date('2026-03-20T14:30:00.000Z'),
        sessionDurationMinutes: 30,
      },
    ] as Booking[]);
    agoraRepo.find.mockResolvedValue([
      {
        id: 'session-1',
        rehearsalId: 'reh-1',
        channelName: 'session_booking-1',
        status: 'active',
        startedAt: new Date('2026-03-20T14:01:00.000Z'),
        endedAt: null,
      },
    ] as any);
    recordingRepo.find.mockResolvedValue([
      {
        id: 'rec-1',
        rehearsalId: 'reh-1',
        createdAt: new Date('2026-03-20T14:35:00.000Z'),
      },
    ] as Recording[]);
    characterRepo.find.mockResolvedValue([]);

    const result = await service.buildList([
      {
        id: 'reh-1',
        status: RehearsalStatus.ACTIVE,
        mode: RehearsalMode.READER_BOOKED,
        runtimeEngine: RehearsalRuntimeEngine.STUDIO,
        bookingId: 'booking-1',
        projectId: null,
        scriptId: null,
        sceneId: null,
        characterId: null,
        rehearsalPartnerType: 'USER',
        rehearsalPartnerUserId: 'reader-1',
        rehearsalPartnerAiName: null,
        rehearsalPartnerAiDescription: null,
        rehearsalPartnerAiImage: null,
        partnerUserName: 'Reader User',
        partnerUserEmail: 'reader@example.com',
        startedAt: null,
        endedAt: null,
        sessionDurationSeconds: null,
        createdAt: new Date('2026-03-13T08:55:00.000Z'),
        updatedAt: new Date('2026-03-13T09:00:00.000Z'),
        metaData: {
          analyticsComputedAt: '2026-03-14T09:00:00.000Z',
          analytics: { completionPct: 100, avgResponseTimeMs: null },
        },
      },
    ]);

    expect(result[0].booking).toEqual(
      expect.objectContaining({
        id: 'booking-1',
        status: 'confirmed',
      }),
    );
    expect(result[0].runtime).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        channelName: 'session_booking-1',
        status: 'active',
      }),
    );
    expect(result[0].recordingsSummary.count).toBe(1);
    expect(result[0].analyticsSummary.completionPct).toBe(100);
  });

  describe('voiceMap exposure', () => {
    const VOICE_MAP = {
      'char-1': 'voiceA',
      'char-2': 'voiceB',
    };

    function makeAiRehearsal(overrides: Partial<Rehersal>): Rehersal {
      return {
        id: 'reh-1',
        userId: 'actor-1',
        projectId: 'project-1',
        scriptId: 'script-1',
        sceneId: null,
        bookingId: null,
        rehearsalPartnerType: 'AI',
        rehearsalPartnerAiName: 'Hazel',
        mode: RehearsalMode.AI,
        runtimeEngine: RehearsalRuntimeEngine.HAZEL,
        status: RehearsalStatus.CREATED,
        characterId: 'char-1',
        recordings: [],
        project: { id: 'project-1', title: 'Pilot' },
        script: { id: 'script-1', title: 'Episode 1' },
        scene: null,
        character: null,
        startedAt: null,
        endedAt: null,
        sessionDurationSeconds: null,
        createdAt: new Date('2026-03-13T08:55:00.000Z'),
        updatedAt: new Date('2026-03-13T09:00:00.000Z'),
        metaData: null,
        ...overrides,
      } as unknown as Rehersal;
    }

    it('exposes voiceMap from metaData on the detail projection', async () => {
      const result = await service.buildDetail(
        makeAiRehearsal({ metaData: { voiceMap: VOICE_MAP } as any }),
      );

      expect(result.voiceMap).toEqual(VOICE_MAP);
      // CREATED is not a locked status
      expect(result.voiceMapFrozen).toBe(false);
    });

    it('returns voiceMap null when metaData is null or lacks the key', async () => {
      const nullMeta = await service.buildDetail(
        makeAiRehearsal({ metaData: null as any }),
      );
      expect(nullMeta.voiceMap).toBeNull();

      const noKey = await service.buildDetail(
        makeAiRehearsal({ metaData: { analytics: {} } as any }),
      );
      expect(noKey.voiceMap).toBeNull();
    });

    it('marks voiceMapFrozen true while playback is ACTIVE or PAUSED', async () => {
      const active = await service.buildDetail(
        makeAiRehearsal({ status: RehearsalStatus.ACTIVE }),
      );
      expect(active.voiceMapFrozen).toBe(true);

      const paused = await service.buildDetail(
        makeAiRehearsal({ status: RehearsalStatus.PAUSED }),
      );
      expect(paused.voiceMapFrozen).toBe(true);
    });

    it('parses string metaData on the list projection', async () => {
      characterRepo.find.mockResolvedValue([]);

      const result = await service.buildList([
        {
          id: 'reh-1',
          status: RehearsalStatus.PAUSED,
          mode: RehearsalMode.AI,
          runtimeEngine: RehearsalRuntimeEngine.HAZEL,
          bookingId: null,
          projectId: null,
          scriptId: null,
          sceneId: null,
          characterId: null,
          rehearsalPartnerType: 'AI',
          rehearsalPartnerUserId: null,
          rehearsalPartnerAiName: 'Hazel',
          rehearsalPartnerAiDescription: null,
          rehearsalPartnerAiImage: null,
          partnerUserName: null,
          partnerUserEmail: null,
          startedAt: null,
          endedAt: null,
          sessionDurationSeconds: null,
          createdAt: new Date('2026-03-13T08:55:00.000Z'),
          updatedAt: new Date('2026-03-13T09:00:00.000Z'),
          metaData: JSON.stringify({ voiceMap: VOICE_MAP }),
        },
      ]);

      expect(result[0].voiceMap).toEqual(VOICE_MAP);
      expect(result[0].voiceMapFrozen).toBe(true);
    });
  });
});
