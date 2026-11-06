/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { HazelSessionService } from './hazel-session.service';

describe('HazelSessionService', () => {
  let service: HazelSessionService;
  let redisStore: Map<string, string>;

  beforeEach(() => {
    redisStore = new Map<string, string>();

    const redis = {
      set: jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
        return 'OK';
      }),
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      del: jest.fn(async (...keys: string[]) => {
        keys.forEach((key) => redisStore.delete(key));
        return keys.length;
      }),
      scan: jest.fn(async () => ['0', []]),
    };

    service = new HazelSessionService(
      redis as any,
      {
        acquireLock: jest.fn(),
        releaseLock: jest.fn(),
        exists: jest.fn(),
      } as any,
      {
        get: jest.fn((key: string, fallback: number) => fallback),
      } as any,
      {
        findById: jest.fn(),
        updateById: jest.fn(),
      } as any,
      { log: jest.fn() } as any,
      {
        getUserRehearsalPreferences: jest.fn().mockResolvedValue({
          display: {},
          sessionDefaults: {
            detectionMode: 'AUTO',
            wordTracking: false,
            autoRecord: true,
            loopMode: false,
          },
        }),
      } as any,
    );
  });

  it('should create a session with the expected initial state shape', async () => {
    await service.createSession('user-1', 'reh-1', 'scene-1', 'char-1');

    const state = await service.getSession('reh-1');
    expect(state.rehearsalId).toBe('reh-1');
    expect(state.userId).toBe('user-1');
    expect(state.sceneId).toBe('scene-1');
    expect(state.characterId).toBe('char-1');
    expect(state.currentLineIndex).toBe(0);
    expect(state.currentTurn).toBe('actor');
    expect(state.status).toBe('preparing');
    expect(state.isHazelSpeaking).toBe(false);
    expect(state.loopIteration).toBe(0);
    expect(state.lockToken).toBeNull();
    expect(state.previousHazelCharacterName).toBeNull();
  });

  it('should update currentTurn and currentLineIndex atomically via setCurrentTurn', async () => {
    await service.createSession('user-1', 'reh-1', 'scene-1', 'char-1');

    await service.setCurrentTurn('reh-1', 'hazel', 5);

    const state = await service.getSession('reh-1');
    expect(state.currentTurn).toBe('hazel');
    expect(state.currentLineIndex).toBe(5);
  });

  it('should persist voiceMap provided at session creation', async () => {
    const voiceMap = { 'char-1': 'voice-abc', 'char-2': 'voice-xyz' };
    await service.createSession(
      'user-1',
      'reh-1',
      'scene-1',
      'char-1',
      voiceMap,
    );

    const state = await service.getSession('reh-1');
    expect(state.voiceMap).toEqual(voiceMap);
  });

  it('should patch arbitrary session fields via updateSession without clobbering others', async () => {
    await service.createSession('user-1', 'reh-1', 'scene-1', 'char-1');

    await service.updateSession('reh-1', {
      totalLines: 42,
      isHazelSpeaking: true,
    });

    const state = await service.getSession('reh-1');
    expect(state.totalLines).toBe(42);
    expect(state.isHazelSpeaking).toBe(true);
    // fields not in the patch must be untouched
    expect(state.sceneId).toBe('scene-1');
    expect(state.currentLineIndex).toBe(0);
  });
});
