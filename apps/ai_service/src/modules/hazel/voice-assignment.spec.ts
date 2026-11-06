/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
// Failing tests reproducing the three voice-assignment bugs.
// Intentionally asserts POST-FIX behavior:
//   - Bug 1: updateVoices override keyed by characterId mutates state.voiceMap
//   - Bug 2: getAudioForLine resolves voiceId from state.voiceMap (not turn.voiceId)
//   - Bug 3: prepareSession voiceOverrides keyed by characterId merge into state.voiceMap
// All three fail on main. Pass after Phase 1 + Phase 2 fixes.

import { HazelController } from './hazel.controller';
import { HazelAudioPreGenerationService } from './hazel-audio-pregeneration.service';
import { VoiceMapperService } from './voice-mapper.service';
import type { Turn } from './types/hazel.types';

describe('Voice assignment bugs (failing repros)', () => {
  describe('Bug 1 — updateVoices uses characterId key', () => {
    let controller: HazelController;
    let sessionService: any;
    let sequenceBuilder: any;
    let audioPregen: any;

    const MAYA_ID = 'uuid-maya';
    const DEFAULT_VOICE = 'defaultVoiceId';
    const NEW_VOICE = 'newVoiceId';

    beforeEach(() => {
      sessionService = {
        getSession: jest.fn().mockResolvedValue({
          userId: 'actor-1',
          status: 'preparing',
          voiceMap: { [MAYA_ID]: DEFAULT_VOICE },
        }),
        updateSession: jest.fn().mockResolvedValue(undefined),
      };

      sequenceBuilder = {
        getSequence: jest.fn().mockResolvedValue([
          {
            index: 0,
            type: 'hazel',
            characterId: MAYA_ID,
            characterName: 'Maya',
            text: 'hello world',
            lines: ['hello world'],
          } as Turn,
        ]),
        storeSequence: jest.fn().mockResolvedValue(undefined),
      };

      audioPregen = {
        pregenerateSession: jest.fn().mockResolvedValue(undefined),
      };

      // Phase 3 added voiceId validation against the cached voice list.
      // Stub the cache to include the new voiceId so validation passes.
      const redis = {
        get: jest.fn().mockImplementation(async (key: string) => {
          if (key === 'hazel:voices:cache') {
            return JSON.stringify([
              { voiceId: DEFAULT_VOICE },
              { voiceId: NEW_VOICE },
            ]);
          }
          return null;
        }),
        set: jest.fn().mockResolvedValue('OK'),
      };

      const rehersalRepository = {
        findById: jest.fn().mockResolvedValue({
          id: 'reh-1',
          userId: 'actor-1',
          metaData: null,
        }),
        updateById: jest.fn().mockResolvedValue({ affected: 1 }),
      };

      controller = new HazelController(
        redis as any,
        { listVoices: jest.fn() } as any,
        {} as any,
        sessionService,
        {} as any,
        sequenceBuilder,
        {} as any,
        audioPregen,
        {} as any,
        {} as any,
        rehersalRepository as any,
        {} as any,
        { log: jest.fn(), flushSession: jest.fn() } as any,
      );
    });

    it('merges override keyed by characterId into state.voiceMap', async () => {
      await controller.updateVoices(
        'reh-1',
        { overrides: { [MAYA_ID]: NEW_VOICE } },
        { user: { id: 'actor-1' } } as any,
      );

      expect(sessionService.updateSession).toHaveBeenCalledWith(
        'reh-1',
        expect.objectContaining({
          voiceMap: expect.objectContaining({ [MAYA_ID]: NEW_VOICE }),
        }),
      );
    });

    it('triggers re-gen for turns matching the overridden characterId', async () => {
      await controller.updateVoices(
        'reh-1',
        { overrides: { [MAYA_ID]: NEW_VOICE } },
        { user: { id: 'actor-1' } } as any,
      );

      expect(audioPregen.pregenerateSession).toHaveBeenCalled();
      const [, turnsArg] = audioPregen.pregenerateSession.mock.calls[0];
      expect(turnsArg).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ characterId: MAYA_ID }),
        ]),
      );
    });
  });

  describe('Bug 2 — getAudioForLine resolves voiceId from state.voiceMap', () => {
    // Post-fix contract: pre-gen service reads session state; turn carries no baked voiceId.
    // Proves the race from Bug 2 is inert — stale session-key hashes don't determine
    // playback voice, because the hash is recomputed from current state at lookup time.
    const MAYA_ID = 'uuid-maya';
    const CURRENT_VOICE = 'currentVoiceFromState';
    const STALE_HASH = 'stale-hash-from-old-pregen';

    it('computes lookup hash from state.voiceMap, not from a baked turn.voiceId', async () => {
      const redis = {
        get: jest.fn().mockImplementation(async (key: string) => {
          if (key.endsWith(':audio:0')) return STALE_HASH;
          return null;
        }),
        getBuffer: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        exists: jest.fn().mockResolvedValue(0),
      };

      const sessionService = {
        getSession: jest.fn().mockResolvedValue({
          voiceMap: { [MAYA_ID]: CURRENT_VOICE },
        }),
      };

      const elevenLabs = {
        generateAudio: jest.fn().mockResolvedValue(Buffer.from('audio-bytes')),
        defaultModelId: 'eleven_turbo_v2',
      };

      const configService = { get: jest.fn().mockReturnValue(5) };

      // cast to any so this compiles against both current (3-arg) and post-fix (4-arg) constructor
      const service = new (HazelAudioPreGenerationService as any)(
        redis,
        elevenLabs,
        configService,
        sessionService,
      );

      const turn: Turn = {
        index: 0,
        type: 'hazel',
        characterId: MAYA_ID,
        characterName: 'Maya',
        text: 'hello world',
        lines: ['hello world'],
      };

      await service.getAudioForLine('reh-1', 0, turn);

      expect(elevenLabs.generateAudio).toHaveBeenCalledWith(
        'hello world',
        CURRENT_VOICE,
        expect.any(String),
      );
    });
  });

  describe('updateVoices status gate', () => {
    // The status whitelist permits voice changes whenever audio is not
    // actively streaming. Pre-fix: only `preparing` and `paused` were
    // accepted, leaving the `ready` window (post-pregen, pre-session.start)
    // as a dead zone the FE could not edit through.

    const MAYA_ID = 'uuid-maya';
    const DEFAULT_VOICE = 'defaultVoiceId';
    const NEW_VOICE = 'newVoiceId';

    function buildController(status: string): {
      controller: HazelController;
      sessionService: any;
    } {
      const sessionService = {
        getSession: jest.fn().mockResolvedValue({
          userId: 'actor-1',
          status,
          voiceMap: { [MAYA_ID]: DEFAULT_VOICE },
        }),
        updateSession: jest.fn().mockResolvedValue(undefined),
      };

      const sequenceBuilder = {
        getSequence: jest.fn().mockResolvedValue([
          {
            index: 0,
            type: 'hazel',
            characterId: MAYA_ID,
            characterName: 'Maya',
            text: 'hello world',
            lines: ['hello world'],
          } as Turn,
        ]),
      };

      const audioPregen = {
        pregenerateSession: jest.fn().mockResolvedValue(undefined),
      };

      const redis = {
        get: jest.fn().mockImplementation(async (key: string) => {
          if (key === 'hazel:voices:cache') {
            return JSON.stringify([
              { voiceId: DEFAULT_VOICE },
              { voiceId: NEW_VOICE },
            ]);
          }
          return null;
        }),
        set: jest.fn().mockResolvedValue('OK'),
      };

      const rehersalRepository = {
        findById: jest.fn().mockResolvedValue({
          id: 'reh-1',
          userId: 'actor-1',
          metaData: null,
        }),
        updateById: jest.fn().mockResolvedValue({ affected: 1 }),
      };

      const controller = new HazelController(
        redis as any,
        { listVoices: jest.fn() } as any,
        {} as any,
        sessionService as any,
        {} as any,
        sequenceBuilder as any,
        {} as any,
        audioPregen as any,
        {} as any,
        {} as any,
        rehersalRepository as any,
        {} as any,
        { log: jest.fn(), flushSession: jest.fn() } as any,
      );
      return { controller, sessionService };
    }

    for (const status of ['preparing', 'ready', 'paused']) {
      it(`accepts overrides when status is ${status}`, async () => {
        const { controller, sessionService } = buildController(status);
        await controller.updateVoices(
          'reh-1',
          { overrides: { [MAYA_ID]: NEW_VOICE } },
          { user: { id: 'actor-1' } } as any,
        );
        expect(sessionService.updateSession).toHaveBeenCalledWith(
          'reh-1',
          expect.objectContaining({
            voiceMap: expect.objectContaining({ [MAYA_ID]: NEW_VOICE }),
          }),
        );
      });
    }

    for (const status of ['active', 'ended']) {
      it(`rejects overrides when status is ${status}`, async () => {
        const { controller, sessionService } = buildController(status);
        await expect(
          controller.updateVoices(
            'reh-1',
            { overrides: { [MAYA_ID]: NEW_VOICE } },
            { user: { id: 'actor-1' } } as any,
          ),
        ).rejects.toThrow(
          /Voice overrides can only be changed while the session is preparing, ready, or paused/,
        );
        expect(sessionService.updateSession).not.toHaveBeenCalled();
      });
    }
  });

  describe('Bug 3 — buildDefaultVoiceMap keys by characterId', () => {
    // Post-fix: map keyed by character.id (UUID). Pre-fix: map keyed by
    // character.name and character.name.toUpperCase() — causes mismatches
    // when prepare-time voiceOverrides are applied to turns.
    it('returns a voiceMap keyed by character.id, not character.name', async () => {
      const redis = { get: jest.fn().mockResolvedValue(null) };
      const elevenLabs = {
        listVoices: jest.fn().mockResolvedValue([
          {
            voiceId: 'voice-A',
            labels: { gender: 'female', age: 'young' },
          },
          {
            voiceId: 'voice-B',
            labels: { gender: 'male', age: 'middle_aged' },
          },
        ]),
      };

      const service = new VoiceMapperService(redis as any, elevenLabs as any);
      await (service as any).loadVoices();

      const characters = [
        { id: 'uuid-maya', name: 'Maya', description: 'young woman' },
        { id: 'uuid-john', name: 'John', description: 'middle-aged man' },
      ] as any[];

      const map = await service.buildDefaultVoiceMap(characters, 'actor-uuid');

      // Post-fix assertion: keys are UUIDs, not character names
      expect(Object.keys(map).sort()).toEqual(['uuid-john', 'uuid-maya']);
      expect(map['Maya']).toBeUndefined();
      expect(map['MAYA']).toBeUndefined();
    });
  });
});
