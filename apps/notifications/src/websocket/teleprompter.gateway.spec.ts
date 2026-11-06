/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { WsException } from '@nestjs/websockets';
import { TeleprompterGateway } from './teleprompter.gateway';

describe('TeleprompterGateway', () => {
  let gateway: TeleprompterGateway;
  let bookingRepository: any;
  let jwtService: any;
  let configService: any;
  let sessionChatService: any;

  beforeEach(() => {
    bookingRepository = {
      findById: jest.fn(),
    };
    jwtService = {
      verify: jest.fn(),
    };
    configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    };
    sessionChatService = {
      addMessage: jest.fn(),
    };

    gateway = new TeleprompterGateway(
      jwtService,
      configService,
      sessionChatService,
      bookingRepository,
    );
    gateway.server = {
      sockets: new Map(),
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as any;
  });

  it('allows the actor to join the booking session room', async () => {
    bookingRepository.findById.mockResolvedValue({
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
    });
    const client = {
      id: 'socket-1',
      join: jest.fn(),
      emit: jest.fn(),
      handshake: { query: {}, auth: {} },
      connected: true,
    } as any;
    (client as any).userId = 'actor-1';

    await gateway.handleSessionJoin(client, { bookingId: 'booking-1' });

    expect(client.join).toHaveBeenCalledWith('session:booking-1');
    expect(client.emit).toHaveBeenCalledWith(
      'session.joined',
      expect.objectContaining({
        bookingId: 'booking-1',
        hasControl: true,
        participantCount: 1,
      }),
    );
    expect((gateway as any).socketToParticipant.get('socket-1')).toMatchObject({
      userId: 'actor-1',
      bookingId: 'booking-1',
      role: 'actor',
      hasControl: true,
    });
  });

  it('rejects session joins by users outside the booking', async () => {
    bookingRepository.findById.mockResolvedValue({
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
    });
    const client = {
      id: 'socket-1',
      join: jest.fn(),
      emit: jest.fn(),
      handshake: { query: {}, auth: {} },
    } as any;
    (client as any).userId = 'intruder-1';

    await expect(
      gateway.handleSessionJoin(client, { bookingId: 'booking-1' }),
    ).rejects.toBeInstanceOf(WsException);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('rejects mismatched query.userId and JWT identities on connect', async () => {
    jwtService.verify.mockReturnValue({ sub: 'actor-1' });
    const client = {
      id: 'socket-1',
      handshake: {
        query: { userId: 'reader-1' },
        auth: { token: 'jwt-token' },
      },
      disconnect: jest.fn(),
      emit: jest.fn(),
    } as any;

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalled();
    expect((client as any).userId).toBeUndefined();
  });

  it('still accepts legacy query.userId auth when no JWT is present', async () => {
    const client = {
      id: 'socket-1',
      handshake: {
        query: { userId: 'actor-1' },
        auth: {},
      },
      disconnect: jest.fn(),
      emit: jest.fn(),
    } as any;

    await gateway.handleConnection(client);

    expect(client.disconnect).not.toHaveBeenCalled();
    expect((client as any).userId).toBe('actor-1');
    expect(client.emit).toHaveBeenCalledWith(
      'connected',
      expect.objectContaining({ userId: 'actor-1' }),
    );
  });

  it('reassigns teleprompter control when the controller disconnects', async () => {
    bookingRepository.findById.mockResolvedValue({
      id: 'booking-1',
      actorUserId: 'actor-1',
      readerUserId: 'reader-1',
    });

    const actorClient = {
      id: 'socket-actor',
      join: jest.fn(),
      emit: jest.fn(),
      handshake: { query: {}, auth: {} },
      connected: true,
    } as any;
    (actorClient as any).userId = 'actor-1';

    const readerClient = {
      id: 'socket-reader',
      join: jest.fn(),
      emit: jest.fn(),
      handshake: { query: {}, auth: {} },
      connected: true,
    } as any;
    (readerClient as any).userId = 'reader-1';

    const sockets = new Map<string, any>([
      ['socket-actor', actorClient],
      ['socket-reader', readerClient],
    ]);
    gateway.server = {
      sockets,
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    } as any;

    await gateway.handleSessionJoin(actorClient, { bookingId: 'booking-1' });
    await gateway.handleSessionJoin(readerClient, { bookingId: 'booking-1' });

    actorClient.emit.mockClear();
    readerClient.emit.mockClear();

    gateway.handleDisconnect(actorClient);

    expect((gateway as any).teleprompterController.get('booking-1')).toBe(
      'socket-reader',
    );
    expect(
      (gateway as any).socketToParticipant.get('socket-reader'),
    ).toMatchObject({
      hasControl: true,
    });
    expect(readerClient.emit).toHaveBeenCalledWith(
      'teleprompter.control_released',
      expect.objectContaining({
        bookingId: 'booking-1',
        releasedBy: 'actor-1',
        reason: 'disconnect',
      }),
    );
    expect(readerClient.emit).toHaveBeenCalledWith(
      'teleprompter.control_granted',
      expect.objectContaining({
        bookingId: 'booking-1',
        grantedTo: 'reader-1',
        grantedBy: 'actor-1',
        reason: 'controller_disconnect',
      }),
    );
  });
});
