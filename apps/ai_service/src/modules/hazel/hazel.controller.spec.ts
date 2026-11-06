/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HazelController } from './hazel.controller';

describe('HazelController', () => {
  let controller: HazelController;
  let sessionService: any;
  let rehersalRepository: any;
  let audioPregen: any;
  let sceneLoader: any;
  let sequenceBuilder: any;
  let voiceMapper: any;
  let characterRepository: any;
  let usageMeter: any;

  beforeEach(() => {
    sessionService = {
      acquireUserLock: jest.fn().mockResolvedValue({
        acquired: true,
        lockToken: 'lock-1',
      }),
      recoverStaleSessionsForUser: jest.fn(),
      createSession: jest.fn(),
      markPreparing: jest.fn(),
      updateSession: jest.fn(),
      setStatus: jest.fn(),
      markReady: jest.fn(),
      forceResetSession: jest.fn(),
      releaseUserLock: jest.fn().mockResolvedValue(undefined),
    };
    rehersalRepository = {
      findById: jest.fn(),
      updateById: jest.fn(),
    };
    audioPregen = {
      pregenerateFirstHazelLine: jest.fn().mockResolvedValue(null),
      pregenerateSession: jest.fn().mockResolvedValue(undefined),
      getProgress: jest.fn(),
    };
    sceneLoader = { loadScene: jest.fn().mockResolvedValue([]) };
    sequenceBuilder = {
      build: jest.fn().mockResolvedValue([]),
      getSequence: jest.fn().mockResolvedValue([]),
    };
    voiceMapper = {
      buildDefaultVoiceMap: jest.fn().mockResolvedValue({}),
    };
    characterRepository = { findByScriptId: jest.fn().mockResolvedValue([]) };
    usageMeter = { checkQuota: jest.fn() };

    controller = new HazelController(
      { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as any,
      { listVoices: jest.fn() } as any,
      {} as any,
      sessionService,
      sceneLoader,
      sequenceBuilder,
      voiceMapper,
      audioPregen,
      usageMeter,
      characterRepository,
      rehersalRepository,
      {} as any,
      { log: jest.fn(), flushSession: jest.fn() } as any,
    );
  });

  it('should reject Hazel prepare when no rehearsal character has been configured', async () => {
    rehersalRepository.findById.mockResolvedValue({
      id: 'reh-1',
      userId: 'actor-1',
      mode: 'AI',
      sceneId: 'scene-1',
      scriptId: 'script-1',
      characterId: null,
    });

    await expect(
      controller.prepareSession({ user: { id: 'actor-1' } } as any, {
        rehearsalId: 'reh-1',
        sceneId: 'scene-1',
        characterId: 'char-1',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'Select a rehearsal character before preparing Hazel',
      ),
    );
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(sessionService.releaseUserLock).toHaveBeenCalledWith(
      'actor-1',
      'lock-1',
    );
  });

  it('should reject Hazel prepare when request character does not match persisted setup', async () => {
    rehersalRepository.findById.mockResolvedValue({
      id: 'reh-1',
      userId: 'actor-1',
      mode: 'AI',
      sceneId: 'scene-1',
      scriptId: 'script-1',
      characterId: 'char-2',
    });

    await expect(
      controller.prepareSession({ user: { id: 'actor-1' } } as any, {
        rehearsalId: 'reh-1',
        sceneId: 'scene-1',
        characterId: 'char-1',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'The requested character does not match the configured rehearsal setup',
      ),
    );
    expect(sessionService.createSession).not.toHaveBeenCalled();
    expect(sessionService.releaseUserLock).toHaveBeenCalledWith(
      'actor-1',
      'lock-1',
    );
  });

  describe('prepareSession — fast-ready flow', () => {
    const validRehearsal = {
      id: 'reh-1',
      userId: 'actor-1',
      mode: 'AI',
      sceneId: 'scene-1',
      scriptId: 'script-1',
      characterId: 'char-1',
      metaData: null,
    };

    beforeEach(() => {
      rehersalRepository.findById.mockResolvedValue(validRehearsal);
    });

    it('should await pregenerateFirstHazelLine, then mark the session ready before returning', async () => {
      const result = await controller.prepareSession(
        { user: { id: 'actor-1' } } as any,
        { rehearsalId: 'reh-1', sceneId: 'scene-1', characterId: 'char-1' },
      );

      // First-line generation must complete before ready is signalled
      const firstLineOrder =
        audioPregen.pregenerateFirstHazelLine.mock.invocationCallOrder[0];
      const setStatusOrder =
        sessionService.setStatus.mock.invocationCallOrder[0];
      const markReadyOrder =
        sessionService.markReady.mock.invocationCallOrder[0];

      expect(firstLineOrder).toBeLessThan(setStatusOrder);
      expect(setStatusOrder).toBeLessThan(markReadyOrder);

      expect(audioPregen.pregenerateFirstHazelLine).toHaveBeenCalledWith(
        'reh-1',
        expect.any(Array),
        expect.any(Object),
      );
      expect(sessionService.setStatus).toHaveBeenCalledWith('reh-1', 'ready');
      expect(sessionService.markReady).toHaveBeenCalledWith('reh-1');

      expect(result).toMatchObject({
        rehearsalId: 'reh-1',
        totalLines: expect.any(Number),
        hazelLineCount: expect.any(Number),
        estimatedPrepSeconds: expect.any(Number),
      });
    });

    it('should kick off background pregenerateSession after marking ready', async () => {
      await controller.prepareSession({ user: { id: 'actor-1' } } as any, {
        rehearsalId: 'reh-1',
        sceneId: 'scene-1',
        characterId: 'char-1',
      });

      // Background call is fire-and-forget; give micro-tasks a tick to register
      await Promise.resolve();

      expect(audioPregen.pregenerateSession).toHaveBeenCalledWith(
        'reh-1',
        expect.any(Array),
        expect.any(Object),
      );

      // Ready must be signalled before background pregen is kicked off
      const markReadyOrder =
        sessionService.markReady.mock.invocationCallOrder[0];
      const backgroundOrder =
        audioPregen.pregenerateSession.mock.invocationCallOrder[0];
      expect(markReadyOrder).toBeLessThan(backgroundOrder);
    });

    it('should reset session and rethrow when pregenerateFirstHazelLine fails', async () => {
      const boom = new Error('TTS quota exceeded');
      audioPregen.pregenerateFirstHazelLine.mockRejectedValue(boom);

      await expect(
        controller.prepareSession({ user: { id: 'actor-1' } } as any, {
          rehearsalId: 'reh-1',
          sceneId: 'scene-1',
          characterId: 'char-1',
        }),
      ).rejects.toThrow(boom);

      expect(sessionService.forceResetSession).toHaveBeenCalledWith(
        'reh-1',
        'actor-1',
        'FAILED',
      );
      // Session must NOT be marked ready when first-line gen fails
      expect(sessionService.setStatus).not.toHaveBeenCalledWith(
        'reh-1',
        'ready',
      );
      expect(sessionService.markReady).not.toHaveBeenCalled();
      // Background pregen must not be started when first-line gen fails
      expect(audioPregen.pregenerateSession).not.toHaveBeenCalled();
    });
  });

  describe('smartTurnCheck', () => {
    const realFetch = global.fetch;
    afterEach(() => {
      global.fetch = realFetch;
    });

    it('forwards decoded PCM to the smart-turn service and returns its result', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ probability: 0.91, complete: true }),
      });
      global.fetch = fetchMock as any;

      const audioB64 = Buffer.from(
        new Int16Array([0, 100, -100, 200]).buffer,
      ).toString('base64');

      const result = await controller.smartTurnCheck({ audio: audioB64 });

      expect(result).toEqual({ probability: 0.91, complete: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toContain('/smart-turn/check');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/octet-stream');
      expect(Buffer.isBuffer(opts.body)).toBe(true);
      expect((opts.body as Buffer).length).toBe(8); // 4 int16 samples
    });

    it('rejects when audio is missing', async () => {
      await expect(controller.smartTurnCheck({} as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects when audio is not valid Int16 PCM (odd byte length)', async () => {
      const oddB64 = Buffer.from([1, 2, 3]).toString('base64');
      await expect(
        controller.smartTurnCheck({ audio: oddB64 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ServiceUnavailable when the upstream returns non-ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      }) as any;
      const audioB64 = Buffer.from(new Int16Array([0, 1]).buffer).toString(
        'base64',
      );
      await expect(
        controller.smartTurnCheck({ audio: audioB64 }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('throws ServiceUnavailable when the upstream is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const audioB64 = Buffer.from(new Int16Array([0, 1]).buffer).toString(
        'base64',
      );
      await expect(
        controller.smartTurnCheck({ audio: audioB64 }),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
