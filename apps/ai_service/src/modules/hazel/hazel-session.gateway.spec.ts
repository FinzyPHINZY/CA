/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { RehearsalEventType } from '@app/common';
import { HazelSessionGateway } from './hazel-session.gateway';

describe('HazelSessionGateway', () => {
  let gateway: HazelSessionGateway;
  let authClient: any;
  let sessionService: any;
  let sequencer: any;
  let eventLogger: any;
  let audioPregen: any;
  let sequenceBuilder: any;
  let hazelRecording: any;
  let deepgramService: any;
  let socket: any;

  beforeEach(() => {
    authClient = { send: jest.fn() };
    sessionService = {
      getSession: jest.fn().mockResolvedValue({
        userId: 'user-1',
        status: 'active',
        currentTurn: 'actor',
        isHazelSpeaking: false,
        currentLineIndex: 3,
        totalLines: 10,
        totalPausedMs: 0,
      }),
      updateSession: jest.fn().mockResolvedValue({
        userId: 'user-1',
        status: 'active',
        currentTurn: 'actor',
        currentLineIndex: 3,
        totalPausedMs: 0,
      }),
      markActive: jest.fn().mockResolvedValue(undefined),
      markPaused: jest.fn().mockResolvedValue(undefined),
      markResumed: jest.fn().mockResolvedValue(undefined),
      markSocketDisconnected: jest.fn().mockResolvedValue(undefined),
      setCurrentTurn: jest.fn().mockResolvedValue(undefined),
      resolveAndPushSettings: jest.fn().mockResolvedValue({
        detectionMode: 'AUTO',
        autoRecord: false,
      }),
      endSession: jest.fn().mockResolvedValue(undefined),
      forceResetSession: jest.fn().mockResolvedValue(undefined),
    };
    sequencer = {
      advance: jest.fn().mockResolvedValue(undefined),
      cancelPauseTimer: jest.fn(),
      cleanup: jest.fn(),
      dispatchTurn: jest.fn().mockResolvedValue(undefined),
      emitLineIndexChanged: jest.fn().mockResolvedValue(undefined),
      jumpTo: jest.fn().mockResolvedValue(undefined),
      onPlaybackDone: jest.fn().mockResolvedValue(undefined),
    };
    eventLogger = {
      log: jest.fn().mockResolvedValue(undefined),
      logTurnEvent: jest.fn().mockResolvedValue(undefined),
      flushSession: jest.fn().mockResolvedValue(undefined),
      setSessionMode: jest.fn(),
    };
    audioPregen = {};
    sequenceBuilder = {
      getTurn: jest.fn().mockResolvedValue({
        type: 'actor',
        lines: ['I would love to keep saying yes and before I know it'],
        characterId: 'char-1',
      }),
      getSequence: jest
        .fn()
        .mockResolvedValue([
          { type: 'actor', lines: ['first line'], characterId: 'char-1' },
        ]),
    };
    hazelRecording = {
      startRecording: jest.fn().mockResolvedValue(undefined),
      requestStop: jest.fn().mockResolvedValue(undefined),
    };
    deepgramService = { revokeKey: jest.fn().mockResolvedValue(undefined) };

    gateway = new HazelSessionGateway(
      authClient,
      sessionService,
      sequencer,
      eventLogger,
      audioPregen,
      sequenceBuilder,
      hazelRecording,
      deepgramService,
    );
    gateway.server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as any;

    socket = {
      id: 'socket-1',
      userId: 'user-1',
      emit: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      handshake: { auth: { token: 'valid-token' } },
    };
  });

  describe('connection / auth', () => {
    it('rejects connections without a token', async () => {
      socket.handshake.auth = {};

      await gateway.handleConnection(socket as any);

      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'AUTH_REQUIRED' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects when auth_service returns no user', async () => {
      authClient.send.mockReturnValue({
        subscribe: undefined,
      });
      // firstValueFrom needs an observable; emulate via a resolved value
      authClient.send.mockReturnValue({
        // minimal thenable-compatible observable stub
        subscribe: (observer: any) => {
          observer.next(null);
          observer.complete();
          return { unsubscribe: jest.fn() };
        },
      });

      await gateway.handleConnection(socket as any);

      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'AUTH_INVALID' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('registers the socket on successful auth', async () => {
      authClient.send.mockReturnValue({
        subscribe: (observer: any) => {
          observer.next({ id: 'user-1' });
          observer.complete();
          return { unsubscribe: jest.fn() };
        },
      });

      await gateway.handleConnection(socket as any);

      expect((socket as any).userId).toBe('user-1');
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('handleDisconnect', () => {
    it('marks the session disconnected when the socket had a rehearsal', async () => {
      authClient.send.mockReturnValue({
        subscribe: (observer: any) => {
          observer.next({ id: 'user-1' });
          observer.complete();
          return { unsubscribe: jest.fn() };
        },
      });
      await gateway.handleConnection(socket as any);
      // simulate the socket joining a rehearsal via session.start bookkeeping
      (gateway as any).socketMap.set(socket.id, {
        userId: 'user-1',
        rehearsalId: 'reh-1',
      });

      await gateway.handleDisconnect(socket as any);

      expect(sessionService.markSocketDisconnected).toHaveBeenCalledWith(
        'reh-1',
      );
    });

    it('is a no-op when the socket had no rehearsal', async () => {
      (gateway as any).socketMap.set(socket.id, {
        userId: 'user-1',
        rehearsalId: null,
      });

      await gateway.handleDisconnect(socket as any);

      expect(sessionService.markSocketDisconnected).not.toHaveBeenCalled();
    });
  });

  describe('session.start', () => {
    beforeEach(() => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'ready',
        currentLineIndex: 0,
        totalLines: 10,
      });
      (gateway as any).socketMap.set(socket.id, {
        userId: 'user-1',
        rehearsalId: null,
      });
    });

    it('rejects when the session belongs to another user', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'someone-else',
        status: 'ready',
      });

      await gateway.onSessionStart(socket as any, { rehearsalId: 'reh-1' });

      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
      expect(sequencer.dispatchTurn).not.toHaveBeenCalled();
    });

    it('rejects when the session is not in a startable state', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'active',
      });

      await gateway.onSessionStart(socket as any, { rehearsalId: 'reh-1' });

      expect(socket.emit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
    });

    it('starts the session, dispatches the first turn, and emits session.started', async () => {
      await gateway.onSessionStart(socket as any, { rehearsalId: 'reh-1' });

      expect(socket.join).toHaveBeenCalledWith('reh-1');
      expect(sessionService.markActive).toHaveBeenCalledWith('reh-1');
      expect(socket.emit).toHaveBeenCalledWith(
        'session.started',
        expect.objectContaining({ rehearsalId: 'reh-1' }),
      );
      expect(sequencer.dispatchTurn).toHaveBeenCalled();
    });
  });

  describe('session.end', () => {
    it('cleans up, revokes the deepgram key, and emits session.ended', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'active',
        deepgramKeyId: 'dg-key-1',
        recordingChannelName: 'hazel_rec_reh-1',
      });

      await gateway.onSessionEnd(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.cleanup).toHaveBeenCalledWith('reh-1');
      expect(deepgramService.revokeKey).toHaveBeenCalledWith('dg-key-1');
      expect(hazelRecording.requestStop).toHaveBeenCalledWith('reh-1');
      expect(sessionService.endSession).toHaveBeenCalledWith('reh-1');
      expect(eventLogger.flushSession).toHaveBeenCalledWith('reh-1');
      expect(gateway.server.to).toHaveBeenCalledWith('reh-1');
    });

    it('does nothing for another user’s session', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'someone-else',
        status: 'active',
      });

      await gateway.onSessionEnd(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.cleanup).not.toHaveBeenCalled();
      expect(deepgramService.revokeKey).not.toHaveBeenCalled();
    });
  });

  describe('session.pause / resume', () => {
    it('pauses an active session and emits session.paused', async () => {
      await gateway.onSessionPause(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.cancelPauseTimer).toHaveBeenCalledWith('reh-1');
      expect(sessionService.markPaused).toHaveBeenCalledWith('reh-1');
      expect(eventLogger.log).toHaveBeenCalledWith(
        'reh-1',
        'pause',
        expect.any(Object),
      );
    });

    it('does not pause a non-active session', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'paused',
      });

      await gateway.onSessionPause(socket as any, { rehearsalId: 'reh-1' });

      expect(sessionService.markPaused).not.toHaveBeenCalled();
    });

    it('resumes a paused session and re-dispatches the current turn', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'paused',
        currentLineIndex: 3,
        totalPausedMs: 0,
        pausedAt: new Date().toISOString(),
      });

      await gateway.onSessionResume(socket as any, { rehearsalId: 'reh-1' });

      expect(sessionService.markResumed).toHaveBeenCalledWith('reh-1');
      expect(eventLogger.log).toHaveBeenCalledWith(
        'reh-1',
        'resume',
        expect.any(Object),
      );
      expect(sequencer.dispatchTurn).toHaveBeenCalled();
    });

    it('does not resume a non-paused session', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'active',
      });

      await gateway.onSessionResume(socket as any, { rehearsalId: 'reh-1' });

      expect(sessionService.markResumed).not.toHaveBeenCalled();
    });
  });

  describe('cue.skip', () => {
    it('advances, cancels the pause timer, and logs line_skipped on an active actor turn', async () => {
      const result = await gateway.onCueSkip(socket as any, {
        rehearsalId: 'reh-1',
      });

      expect(result).toEqual({ skipped: true });
      expect(sequencer.advance).toHaveBeenCalledWith('reh-1', gateway.server);
      expect(sequencer.cancelPauseTimer).toHaveBeenCalledWith('reh-1');
      expect(eventLogger.logTurnEvent).toHaveBeenCalledWith(
        'reh-1',
        'line_skipped',
        expect.any(Object),
        expect.objectContaining({ lineIndex: 3 }),
      );
    });

    it('returns invalid_session and does not advance when the session is missing', async () => {
      sessionService.getSession.mockRejectedValueOnce(new Error('not found'));

      const result = await gateway.onCueSkip(socket as any, {
        rehearsalId: 'reh-missing',
      });

      expect(result).toEqual({ skipped: false, reason: 'invalid_session' });
      expect(sequencer.advance).not.toHaveBeenCalled();
      expect(eventLogger.logTurnEvent).not.toHaveBeenCalled();
    });

    it('returns not_active and does not advance when the session is paused', async () => {
      sessionService.getSession.mockResolvedValueOnce({
        status: 'paused',
        currentTurn: 'actor',
        currentLineIndex: 3,
      });

      const result = await gateway.onCueSkip(socket as any, {
        rehearsalId: 'reh-1',
      });

      expect(result).toEqual({ skipped: false, reason: 'not_active' });
      expect(sequencer.advance).not.toHaveBeenCalled();
      expect(eventLogger.logTurnEvent).not.toHaveBeenCalled();
    });

    it('returns not_actor_turn and does not advance when Hazel is the current turn', async () => {
      sessionService.getSession.mockResolvedValueOnce({
        status: 'active',
        currentTurn: 'hazel',
        currentLineIndex: 4,
      });

      const result = await gateway.onCueSkip(socket as any, {
        rehearsalId: 'reh-1',
      });

      expect(result).toEqual({ skipped: false, reason: 'not_actor_turn' });
      expect(sequencer.advance).not.toHaveBeenCalled();
      expect(sequencer.cancelPauseTimer).not.toHaveBeenCalled();
      expect(eventLogger.logTurnEvent).not.toHaveBeenCalled();
    });
  });

  describe('manual:advance', () => {
    it('advances in MANUAL mode and logs line_completed', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'active',
        currentTurn: 'actor',
        currentLineIndex: 3,
        settings: { detectionMode: 'MANUAL' },
      });

      await gateway.onManualAdvance(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.advance).toHaveBeenCalledWith('reh-1', gateway.server);
      expect(eventLogger.logTurnEvent).toHaveBeenCalledWith(
        'reh-1',
        'line_completed',
        expect.any(Object),
        expect.objectContaining({ triggerType: 'manual_advance' }),
      );
    });

    it('is a no-op outside MANUAL mode', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'active',
        currentTurn: 'actor',
        currentLineIndex: 3,
        settings: { detectionMode: 'AUTO' },
      });

      await gateway.onManualAdvance(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.advance).not.toHaveBeenCalled();
    });

    it('is a no-op when it is not the actor turn', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'active',
        currentTurn: 'hazel',
        currentLineIndex: 3,
        settings: { detectionMode: 'MANUAL' },
      });

      await gateway.onManualAdvance(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.advance).not.toHaveBeenCalled();
    });
  });

  describe('hazel.playback.done', () => {
    it('advances via the sequencer when the active session belongs to the user', async () => {
      await gateway.onPlaybackDone(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.onPlaybackDone).toHaveBeenCalledWith(
        'reh-1',
        gateway.server,
      );
    });

    it('is a no-op for another user’s session', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'someone-else',
        status: 'active',
      });

      await gateway.onPlaybackDone(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.onPlaybackDone).not.toHaveBeenCalled();
    });

    it('is a no-op when the session is not active', async () => {
      sessionService.getSession.mockResolvedValue({
        userId: 'user-1',
        status: 'paused',
      });

      await gateway.onPlaybackDone(socket as any, { rehearsalId: 'reh-1' });

      expect(sequencer.onPlaybackDone).not.toHaveBeenCalled();
    });
  });

  describe('session.jump_to', () => {
    it('cancels the pause timer and jumps to the requested line', async () => {
      await gateway.onJumpTo(socket as any, {
        rehearsalId: 'reh-1',
        lineIndex: 7,
      });

      expect(sequencer.cancelPauseTimer).toHaveBeenCalledWith('reh-1');
      expect(sequencer.jumpTo).toHaveBeenCalledWith(
        'reh-1',
        7,
        gateway.server,
        true,
      );
    });

    it('is a no-op when the session cannot be loaded', async () => {
      sessionService.getSession.mockResolvedValueOnce(null);

      await gateway.onJumpTo(socket as any, {
        rehearsalId: 'reh-1',
        lineIndex: 7,
      });

      expect(sequencer.jumpTo).not.toHaveBeenCalled();
    });
  });

  describe('turn.end', () => {
    const activeAutoSession = {
      userId: 'u1',
      status: 'active',
      currentTurn: 'actor',
      currentLineIndex: 3,
      settings: { detectionMode: 'AUTO', wordTracking: false },
      actorTurnStartedAt: new Date(Date.now() - 5000).toISOString(),
    };

    beforeEach(() => {
      socket.userId = 'u1';
      (socket as any).userId = 'u1';
      sessionService.getSession.mockResolvedValue(activeAutoSession);
      sequenceBuilder.getTurn.mockResolvedValue({
        type: 'actor',
        lines: ['hearts of gold'],
        characterId: 'char-1',
      });
    });

    it('advances on actor turn-end (AUTO)', async () => {
      await gateway.onTurnEnd(socket as any, {
        rehearsalId: 'r1',
        lineIndex: 3,
        transcript: 'hearts of gold',
      });

      expect(sequencer.advance).toHaveBeenCalledTimes(1);
      expect(sequencer.advance).toHaveBeenCalledWith('r1', gateway.server);
      expect(eventLogger.logTurnEvent).toHaveBeenCalledWith(
        'r1',
        RehearsalEventType.LINE_COMPLETED,
        expect.any(Object),
        expect.objectContaining({
          trigger: 'turn_end',
          responseTimeMs: expect.any(Number),
        }),
      );
      // responseTimeMs should reflect the ~5s start time
      const logCall = (eventLogger.logTurnEvent as jest.Mock).mock.calls.find(
        ([, eventType]: [string, string]) =>
          eventType === RehearsalEventType.LINE_COMPLETED,
      );
      expect(logCall[3].responseTimeMs).toBeGreaterThanOrEqual(4000);
    });

    it('ignores stale lineIndex', async () => {
      await gateway.onTurnEnd(socket as any, {
        rehearsalId: 'r1',
        lineIndex: 2,
        transcript: 'hearts of gold',
      });

      expect(sequencer.advance).not.toHaveBeenCalled();
    });

    it('wordTracking ON + off-script (long line) → emits actor.line_mismatch AND still advances', async () => {
      sessionService.getSession.mockResolvedValue({
        ...activeAutoSession,
        settings: { detectionMode: 'AUTO', wordTracking: true },
      });
      // Expected line must have enough content words to be judgeable (>= 4).
      sequenceBuilder.getTurn.mockResolvedValue({
        type: 'actor',
        lines: ['truly hearts of gold sweet kind generous people'],
        characterId: 'char-1',
      });

      const emitSpy = jest.fn();
      gateway.server = {
        to: jest.fn().mockReturnValue({ emit: emitSpy }),
      } as any;

      await gateway.onTurnEnd(socket as any, {
        rehearsalId: 'r1',
        lineIndex: 3,
        transcript: 'cheeseburger fries pizza milkshake',
      });

      expect(emitSpy).toHaveBeenCalledWith(
        'actor.line_mismatch',
        expect.objectContaining({ lineIndex: 3 }),
      );
      expect(sequencer.advance).toHaveBeenCalledWith('r1', gateway.server);
    });

    it('wordTracking ON but expected line too short → NO mismatch, still advances', async () => {
      sessionService.getSession.mockResolvedValue({
        ...activeAutoSession,
        settings: { detectionMode: 'AUTO', wordTracking: true },
      });
      // 'hearts of gold' = 2 content words (< MISMATCH_MIN_EXPECTED_WORDS):
      // overlap is too noisy to judge, so even an off-script read is NOT flagged.
      sequenceBuilder.getTurn.mockResolvedValue({
        type: 'actor',
        lines: ['hearts of gold'],
        characterId: 'char-1',
      });

      const emitSpy = jest.fn();
      gateway.server = {
        to: jest.fn().mockReturnValue({ emit: emitSpy }),
      } as any;

      await gateway.onTurnEnd(socket as any, {
        rehearsalId: 'r1',
        lineIndex: 3,
        transcript: 'cheeseburger fries pizza milkshake',
      });

      expect(emitSpy).not.toHaveBeenCalledWith(
        'actor.line_mismatch',
        expect.anything(),
      );
      expect(sequencer.advance).toHaveBeenCalledWith('r1', gateway.server);
    });

    it('wordTracking ON but transcript too thin (STT drop) → NO mismatch, still advances', async () => {
      sessionService.getSession.mockResolvedValue({
        ...activeAutoSession,
        settings: { detectionMode: 'AUTO', wordTracking: true },
      });
      sequenceBuilder.getTurn.mockResolvedValue({
        type: 'actor',
        lines: ['truly hearts of gold sweet kind generous people'],
        characterId: 'char-1',
      });

      const emitSpy = jest.fn();
      gateway.server = {
        to: jest.fn().mockReturnValue({ emit: emitSpy }),
      } as any;

      // Empty / dropped transcript: can't judge → must not false-flag.
      await gateway.onTurnEnd(socket as any, {
        rehearsalId: 'r1',
        lineIndex: 3,
        transcript: '',
      });

      expect(emitSpy).not.toHaveBeenCalledWith(
        'actor.line_mismatch',
        expect.anything(),
      );
      expect(sequencer.advance).toHaveBeenCalledWith('r1', gateway.server);
    });

    it('wordTracking OFF → no mismatch emit, advance still called', async () => {
      // default session already has wordTracking: false
      await gateway.onTurnEnd(socket as any, {
        rehearsalId: 'r1',
        lineIndex: 3,
        transcript: 'cheeseburger and fries please',
      });

      const emittedEvents = (gateway.server.to as jest.Mock).mock.calls.flatMap(
        ([_room]: [string]) => {
          const toReturn = (gateway.server.to as jest.Mock).mock.results.find(
            (r: any) => r.value,
          )?.value;
          return toReturn ? [] : [];
        },
      );

      // The simplest check: server.to should not have been called with 'r1'
      // for a mismatch emit (advance doesn't call server.to at all — sequencer does).
      const mismatchEmit = (gateway.server.to as jest.Mock).mock.calls.filter(
        ([room]: [string]) => room === 'r1',
      );
      // With wordTracking false the mismatch branch is skipped, so server.to
      // is never called from onTurnEnd itself (sequencer.advance is a mock and
      // does not call it). Expect 0 calls on gateway.server.to.
      expect(mismatchEmit.length).toBe(0);
      expect(sequencer.advance).toHaveBeenCalledWith('r1', gateway.server);
    });
  });
});
