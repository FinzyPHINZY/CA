/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { TurnSequencerService } from './turn-sequencer.service';

describe('TurnSequencerService', () => {
  let service: TurnSequencerService;
  let sessionService: any;
  let audioPregen: any;
  let eventLogger: any;
  let server: any;

  beforeEach(() => {
    sessionService = {
      updateSession: jest.fn().mockResolvedValue(undefined),
      markPaused: jest.fn().mockResolvedValue(undefined),
      getSession: jest.fn(),
      setCurrentTurn: jest.fn(),
    };
    audioPregen = {
      getAudioForLine: jest.fn(),
      getAudioStreamForLine: jest.fn(),
    };
    eventLogger = {
      log: jest.fn().mockResolvedValue(undefined),
      logTurnEvent: jest.fn().mockResolvedValue(undefined),
    };
    server = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    };

    service = new TurnSequencerService(
      sessionService,
      { getTurn: jest.fn(), getSequence: jest.fn() } as any,
      audioPregen,
      eventLogger,
    );
  });

  it('should pause and emit hazel.audio_failed instead of auto-advancing on Hazel audio failure', async () => {
    audioPregen.getAudioStreamForLine.mockImplementation(
      async function* (): AsyncIterable<Buffer> {
        throw new Error('tts failed');
      },
    );
    const advanceSpy = jest.spyOn(service, 'advance').mockResolvedValue();

    await service.handleHazelTurn(
      'reh-1',
      {
        index: 4,
        type: 'hazel',
        text: 'Hello there',
        lines: ['Hello there'],
        characterId: 'char-2',
        characterName: 'HAZEL',
      },
      {
        previousHazelCharacterName: null,
      } as any,
      server as any,
    );

    expect(sessionService.updateSession).toHaveBeenCalledWith(
      'reh-1',
      expect.objectContaining({
        isHazelSpeaking: false,
        status: 'paused',
      }),
    );
    expect(sessionService.markPaused).toHaveBeenCalledWith('reh-1');
    expect(eventLogger.log).toHaveBeenCalledWith(
      'reh-1',
      'pause',
      expect.objectContaining({
        lineIndex: 4,
        reason: 'hazel_audio_failure',
      }),
    );
    expect(server.to).toHaveBeenCalledWith('reh-1');
    const emit = server.to().emit as jest.Mock;
    expect(emit).toHaveBeenCalledWith(
      'hazel.audio_failed',
      expect.objectContaining({
        lineIndex: 4,
        recoverable: true,
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      'session.paused',
      expect.objectContaining({
        rehearsalId: 'reh-1',
        reason: 'hazel_audio_failure',
      }),
    );
    expect(advanceSpy).not.toHaveBeenCalled();
  });

  it('should emit raw binary MP3 chunks between hazel.speaking.start and hazel.speaking.end', async () => {
    const audio = Buffer.alloc(5000, 1);
    audioPregen.getAudioStreamForLine.mockImplementation(
      async function* (): AsyncIterable<Buffer> {
        yield audio;
      },
    );
    const advanceSpy = jest.spyOn(service, 'advance').mockResolvedValue();
    sessionService.getSession.mockResolvedValue({ status: 'active' });

    await service.handleHazelTurn(
      'reh-1',
      {
        index: 4,
        type: 'hazel',
        text: 'Hello there',
        lines: ['Hello there'],
        characterId: 'char-2',
        characterName: 'HAZEL',
      },
      {
        previousHazelCharacterName: 'HAZEL',
      } as any,
      server as any,
    );

    const emit = server.to().emit as jest.Mock;
    const hazelAudioCalls = emit.mock.calls.filter(
      ([eventName]) => eventName === 'hazel.audio',
    );

    expect(emit).toHaveBeenCalledWith('hazel.speaking.start', { lineIndex: 4 });
    // 5000-byte buffer fits in a single 16KB chunk
    expect(hazelAudioCalls).toHaveLength(1);
    expect(Buffer.isBuffer(hazelAudioCalls[0][1])).toBe(true);
    expect(hazelAudioCalls[0][1].length).toBe(5000);
    expect(emit).toHaveBeenCalledWith('hazel.speaking.end', { lineIndex: 4 });
    expect(advanceSpy).not.toHaveBeenCalled();

    await service.onPlaybackDone('reh-1', server);

    expect(advanceSpy).toHaveBeenCalledWith('reh-1', server);
  });

  describe('handleActorTurn', () => {
    const turn: any = {
      index: 2,
      type: 'actor',
      text: 'To be or not to be',
      lines: ['To be or not to be'],
      characterId: 'char-1',
      characterName: 'HAMLET',
    };

    it('AUTO mode: emits actor.turn with mode AUTO and does not schedule auto-advance', async () => {
      sessionService.getSession.mockResolvedValue({
        settings: { detectionMode: 'AUTO' },
      });

      await service.handleActorTurn('reh-1', turn, server as any);

      const emit = server.to().emit as jest.Mock;
      expect(emit).toHaveBeenCalledWith(
        'actor.turn',
        expect.objectContaining({
          lineIndex: 2,
          lines: ['To be or not to be'],
          characterName: 'HAMLET',
          mode: 'AUTO',
        }),
      );
      expect(eventLogger.logTurnEvent).toHaveBeenCalledWith(
        'reh-1',
        'line_started',
        turn,
        { mode: 'AUTO' },
      );
      // actorTurnStartedAt should be recorded before emitting actor.turn
      expect(sessionService.updateSession).toHaveBeenCalledWith(
        'reh-1',
        expect.objectContaining({ actorTurnStartedAt: expect.any(String) }),
      );
    });

    it('AUTO mode (default when no detectionMode set): emits with mode AUTO', async () => {
      sessionService.getSession.mockResolvedValue({ settings: {} });

      await service.handleActorTurn('reh-1', turn, server as any);

      const emit = server.to().emit as jest.Mock;
      expect(emit).toHaveBeenCalledWith(
        'actor.turn',
        expect.objectContaining({ mode: 'AUTO' }),
      );
    });

    it('MANUAL mode: emits actor.turn with mode MANUAL and does not schedule auto-advance', async () => {
      sessionService.getSession.mockResolvedValue({
        settings: { detectionMode: 'MANUAL' },
      });

      await service.handleActorTurn('reh-1', turn, server as any);

      const emit = server.to().emit as jest.Mock;
      expect(emit).toHaveBeenCalledWith(
        'actor.turn',
        expect.objectContaining({
          lineIndex: 2,
          mode: 'MANUAL',
        }),
      );
      expect(eventLogger.logTurnEvent).toHaveBeenCalledWith(
        'reh-1',
        'line_started',
        turn,
        { mode: 'MANUAL' },
      );
    });

    it('LISTEN mode: emits actor.turn and schedules auto-advance via pacing timer', async () => {
      jest.useFakeTimers();
      sessionService.getSession.mockResolvedValue({
        settings: { detectionMode: 'LISTEN' },
        status: 'active',
      });
      const advanceSpy = jest.spyOn(service, 'advance').mockResolvedValue();

      await service.handleActorTurn('reh-1', turn, server as any);

      const emit = server.to().emit as jest.Mock;
      expect(emit).toHaveBeenCalledWith(
        'actor.turn',
        expect.objectContaining({ mode: 'LISTEN' }),
      );
      expect(eventLogger.logTurnEvent).toHaveBeenCalledWith(
        'reh-1',
        'line_started',
        turn,
        { mode: 'LISTEN' },
      );

      // advance should NOT have been called yet
      expect(advanceSpy).not.toHaveBeenCalled();

      // advance should fire after the pacing delay
      await jest.runAllTimersAsync();
      expect(advanceSpy).toHaveBeenCalledWith('reh-1', server);

      jest.useRealTimers();
    });
  });
});
