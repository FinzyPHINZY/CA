import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BookingRepository } from '@app/common';
import { SessionChatService, ChatMessage } from './session-chat.service';

// payload shapes for teleprompter control events
interface TeleprompterScrollPayload {
  bookingId: string;
  scrollTop: number; // pixels from top
  currentLineIndex: number;
}

interface TeleprompterLineHighlightPayload {
  bookingId: string;
  lineIndex: number;
  sceneId: string;
  elementType: 'dialogue' | 'action' | 'parenthetical' | 'scene_heading';
}

interface TeleprompterSceneChangePayload {
  bookingId: string;
  sceneId: string;
  sceneIndex: number;
  direction: 'next' | 'prev' | 'jump';
}

interface TeleprompterControlRequestPayload {
  bookingId: string;
  requestedBy: string; // userId
}

interface TeleprompterControlGrantPayload {
  bookingId: string;
  grantedTo: string; // userId
  grantedBy: string; // userId
}

interface SessionJoinPayload {
  bookingId: string;
  token?: string; // optional JWT token if not in handshake
}

interface ChatSendPayload {
  bookingId: string;
  type: 'text' | 'file';
  content?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  senderName: string;
  senderAvatar?: string;
}

const CHAT_MAX_CONTENT_LENGTH = 2000;
const CHAT_RATE_LIMIT_WINDOW_MS = 1000;
const CHAT_RATE_LIMIT_MAX = 5;

// connection metadata per socket
interface SessionParticipant {
  userId: string;
  bookingId: string;
  socketId: string;
  role: 'actor' | 'reader' | 'observer';
  joinedAt: Date;
  hasControl: boolean; // who controls the teleprompter scroll
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/session',
})
export class TeleprompterGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(TeleprompterGateway.name);

  // socketId -> participant info
  private readonly socketToParticipant = new Map<string, SessionParticipant>();

  // bookingId -> Set<socketId>
  private readonly sessionSockets = new Map<string, Set<string>>();

  // bookingId -> socketId of current teleprompter controller
  private readonly teleprompterController = new Map<string, string>();

  // chat rate limiting: `userId:bookingId` -> array of recent timestamps
  private readonly chatRateLimits = new Map<string, number[]>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessionChatService: SessionChatService,
    private readonly bookingRepository: BookingRepository,
  ) {}

  // connection lifecycle
  async handleConnection(client: Socket) {
    try {
      const userId = await this.extractUserId(client);
      if (!userId) {
        this.logger.warn(
          `[/session] Rejected unauthenticated socket ${client.id}`,
        );
        client.disconnect();
        return;
      }

      // store userId on the socket for use in message handlers
      (client as any).userId = userId;

      this.logger.log(
        `[/session] Client connected: ${client.id} (user ${userId})`,
      );

      client.emit('connected', {
        message: 'Connected to session gateway',
        userId,
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      this.logger.error(`[/session] Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const participant = this.socketToParticipant.get(client.id);

    if (participant) {
      const { bookingId, userId } = participant;

      // remove from session room tracking
      const sessionSet = this.sessionSockets.get(bookingId);
      if (sessionSet) {
        sessionSet.delete(client.id);
        if (sessionSet.size === 0) {
          this.sessionSockets.delete(bookingId);
        }
      }

      // if they held teleprompter control, release it
      const controllerId = this.teleprompterController.get(bookingId);
      if (controllerId === client.id) {
        this.teleprompterController.delete(bookingId);
        participant.hasControl = false;
        // notify remaining participants that control was released
        this.broadcastToSession(
          bookingId,
          client.id,
          'teleprompter.control_released',
          {
            bookingId,
            releasedBy: userId,
            reason: 'disconnect',
            timestamp: new Date().toISOString(),
          },
        );

        const reassignedParticipant =
          this.assignControlToNextParticipant(bookingId);
        if (reassignedParticipant) {
          this.broadcastToSession(
            bookingId,
            null,
            'teleprompter.control_granted',
            {
              bookingId,
              grantedTo: reassignedParticipant.userId,
              grantedBy: userId,
              reason: 'controller_disconnect',
              timestamp: new Date().toISOString(),
            },
          );

          this.logger.log(
            `[/session] Teleprompter control reassigned after disconnect: ${userId} -> ${reassignedParticipant.userId} (booking ${bookingId})`,
          );
        }
      }

      this.socketToParticipant.delete(client.id);

      // notify remaining participants that this user disconnected
      this.broadcastToSession(bookingId, client.id, 'participant.left', {
        bookingId,
        userId,
        socketId: client.id,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(
        `[/session] Client disconnected: ${client.id} (user ${userId}, booking ${bookingId})`,
      );
    } else {
      this.logger.debug(`[/session] Unknown socket disconnected: ${client.id}`);
    }
  }

  // message handlers

  // join a session room. must be called before any other events.
  @SubscribeMessage('session.join')
  async handleSessionJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SessionJoinPayload,
  ) {
    const userId = (client as any).userId;
    if (!userId) throw new WsException('Not authenticated');

    const { bookingId } = payload;
    if (!bookingId) throw new WsException('bookingId is required');

    const role = await this.getAuthorizedRole(bookingId, userId);

    // join the socket.io room for this session
    await client.join(`session:${bookingId}`);

    // Track participant
    const participant: SessionParticipant = {
      userId,
      bookingId,
      socketId: client.id,
      role,
      joinedAt: new Date(),
      hasControl: false,
    };

    this.socketToParticipant.set(client.id, participant);

    if (!this.sessionSockets.has(bookingId)) {
      this.sessionSockets.set(bookingId, new Set());
    }
    this.sessionSockets.get(bookingId)!.add(client.id);

    // first participant in the session gets teleprompter control by default
    if (!this.teleprompterController.has(bookingId)) {
      this.teleprompterController.set(bookingId, client.id);
      participant.hasControl = true;
    }

    // ack to the joining client
    client.emit('session.joined', {
      bookingId,
      hasControl: participant.hasControl,
      participantCount: this.sessionSockets.get(bookingId)!.size,
      timestamp: new Date().toISOString(),
    });

    // notify others in the room
    this.broadcastToSession(bookingId, client.id, 'participant.joined', {
      bookingId,
      userId,
      socketId: client.id,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `[/session] User ${userId} joined session room for booking ${bookingId}`,
    );
  }

  // broadcast teleprompter scroll position to all other participants in the session.
  // only the participant who currently has control should emit this.
  @SubscribeMessage('teleprompter.scroll')
  handleScroll(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TeleprompterScrollPayload,
  ) {
    this.validateController(client, payload.bookingId);
    this.broadcastToSession(
      payload.bookingId,
      client.id,
      'teleprompter.scroll',
      {
        ...payload,
        sentBy: (client as any).userId,
        timestamp: new Date().toISOString(),
      },
    );
  }

  // broadcast current line highlight to all other participants.
  @SubscribeMessage('teleprompter.line_highlight')
  handleLineHighlight(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TeleprompterLineHighlightPayload,
  ) {
    this.validateController(client, payload.bookingId);
    this.broadcastToSession(
      payload.bookingId,
      client.id,
      'teleprompter.line_highlight',
      {
        ...payload,
        sentBy: (client as any).userId,
        timestamp: new Date().toISOString(),
      },
    );
  }

  // broadcast a scene change to all participants.
  @SubscribeMessage('teleprompter.scene_change')
  handleSceneChange(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TeleprompterSceneChangePayload,
  ) {
    this.validateController(client, payload.bookingId);
    this.broadcastToSession(
      payload.bookingId,
      client.id,
      'teleprompter.scene_change',
      {
        ...payload,
        sentBy: (client as any).userId,
        timestamp: new Date().toISOString(),
      },
    );
  }

  // request teleprompter control. broadcasts the request to the current controller.
  // the current controller must explicitly grant control via `teleprompter.control_grant`.
  @SubscribeMessage('teleprompter.control_request')
  handleControlRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TeleprompterControlRequestPayload,
  ) {
    const userId = (client as any).userId;
    if (!userId) throw new WsException('Not authenticated');

    // notify the current controller of the request
    const controllerId = this.teleprompterController.get(payload.bookingId);
    if (controllerId && controllerId !== client.id) {
      const controllerSocket = this.getSocket(controllerId);
      if (controllerSocket) {
        controllerSocket.emit('teleprompter.control_request', {
          bookingId: payload.bookingId,
          requestedBy: userId,
          requestedBySocketId: client.id,
          timestamp: new Date().toISOString(),
        });
      }
    }

    this.logger.debug(
      `[/session] User ${userId} requested teleprompter control for booking ${payload.bookingId}`,
    );
  }

  // grant teleprompter control to another participant.
  // only the current controller can grant control.
  @SubscribeMessage('teleprompter.control_grant')
  handleControlGrant(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TeleprompterControlGrantPayload,
  ) {
    const userId = (client as any).userId;
    if (!userId) throw new WsException('Not authenticated');

    const { bookingId, grantedTo } = payload;

    // verify the sender currently holds control
    const currentControllerId = this.teleprompterController.get(bookingId);
    if (currentControllerId !== client.id) {
      throw new WsException('You do not currently hold teleprompter control');
    }

    // find the target participant's socket
    const targetSocket = this.findSocketByUserId(bookingId, grantedTo);
    if (!targetSocket) {
      throw new WsException(`User ${grantedTo} is not in this session`);
    }

    // transfer control
    this.teleprompterController.set(bookingId, targetSocket.id);

    const prevParticipant = this.socketToParticipant.get(client.id);
    const nextParticipant = this.socketToParticipant.get(targetSocket.id);
    if (prevParticipant) prevParticipant.hasControl = false;
    if (nextParticipant) nextParticipant.hasControl = true;

    // broadcast to entire session
    this.broadcastToSession(bookingId, null, 'teleprompter.control_granted', {
      bookingId,
      grantedTo,
      grantedBy: userId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(
      `[/session] Teleprompter control transferred: ${userId} -> ${grantedTo} (booking ${bookingId})`,
    );
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    return { event: 'pong', data: { timestamp: new Date().toISOString() } };
  }

  // send a chat message to all participants in the session.
  @SubscribeMessage('chat.send')
  async handleChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChatSendPayload,
  ) {
    const userId = (client as any).userId;
    if (!userId) throw new WsException('Not authenticated');

    const participant = this.socketToParticipant.get(client.id);
    if (!participant) {
      throw new WsException('You must join a session before sending messages');
    }

    const { bookingId } = participant;

    // rate limit check
    const rateLimitKey = `${userId}:${bookingId}`;
    const now = Date.now();
    const timestamps = this.chatRateLimits.get(rateLimitKey) || [];
    const recent = timestamps.filter(
      (t) => now - t < CHAT_RATE_LIMIT_WINDOW_MS,
    );
    if (recent.length >= CHAT_RATE_LIMIT_MAX) {
      throw new WsException(
        'Rate limit exceeded. Maximum 5 messages per second.',
      );
    }
    recent.push(now);
    this.chatRateLimits.set(rateLimitKey, recent);

    // validate payload
    if (!payload.type || !['text', 'file'].includes(payload.type)) {
      throw new WsException('Message type must be "text" or "file"');
    }
    if (
      payload.type === 'text' &&
      (!payload.content || !payload.content.trim())
    ) {
      throw new WsException('Text message content is required');
    }
    if (
      payload.type === 'text' &&
      payload.content &&
      payload.content.length > CHAT_MAX_CONTENT_LENGTH
    ) {
      throw new WsException(
        `Message content exceeds maximum length of ${CHAT_MAX_CONTENT_LENGTH} characters`,
      );
    }
    if (payload.type === 'file' && !payload.fileUrl) {
      throw new WsException('File URL is required for file messages');
    }

    try {
      const message = await this.sessionChatService.addMessage(bookingId, {
        senderId: userId,
        senderName: payload.senderName || 'Unknown',
        senderAvatar: payload.senderAvatar,
        type: payload.type,
        content: payload.type === 'text' ? payload.content?.trim() : undefined,
        fileUrl: payload.type === 'file' ? payload.fileUrl : undefined,
        fileName: payload.type === 'file' ? payload.fileName : undefined,
        fileSize: payload.type === 'file' ? payload.fileSize : undefined,
        mimeType: payload.type === 'file' ? payload.mimeType : undefined,
      });

      // broadcast to entire room (including sender for confirmation)
      this.server.to(`session:${bookingId}`).emit('chat.message', message);

      this.logger.debug(
        `[/session] Chat message ${message.id} sent by ${userId} in session ${bookingId}`,
      );

      return {
        event: 'chat.send.ack',
        data: { id: message.id, timestamp: message.timestamp },
      };
    } catch (error: any) {
      this.logger.error(
        `[/session] Failed to persist chat message: ${error.message}`,
      );
      throw new WsException('Failed to send message. Please try again.');
    }
  }

  // clean up chat rate limits for a completed session.
  cleanupSession(bookingId: string): void {
    for (const key of this.chatRateLimits.keys()) {
      if (key.endsWith(`:${bookingId}`)) {
        this.chatRateLimits.delete(key);
      }
    }
  }

  // public API for server-side emission (called from core service via RabbitMQ consumer)
  // emit a server-initiated event to all participants in a session room.
  emitToSession(bookingId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(`session:${bookingId}`).emit(event, payload);
    this.logger.debug(
      `[/session] Emitted '${event}' to session room for booking ${bookingId}`,
    );
  }

  // emit a server-initiated event to a specific user in a session.
  emitToUser(
    bookingId: string,
    userId: string,
    event: string,
    payload: unknown,
  ): void {
    const socket = this.findSocketByUserId(bookingId, userId);
    if (socket) {
      socket.emit(event, payload);
    }
  }

  // broadcast to all sockets in a session room except the sender (excludedSocketId).
  // pass null for excludedSocketId to broadcast to everyone including sender.
  private broadcastToSession(
    bookingId: string,
    excludedSocketId: string | null,
    event: string,
    payload: unknown,
  ): void {
    const sessionSet = this.sessionSockets.get(bookingId);
    if (!sessionSet) return;

    for (const socketId of sessionSet) {
      if (socketId === excludedSocketId) continue;
      const socket = this.getSocket(socketId);
      if (socket?.connected) {
        socket.emit(event, payload);
      }
    }
  }

  // verify the sending socket holds teleprompter control for the given booking.
  private validateController(client: Socket, bookingId: string): void {
    const userId = (client as any).userId;
    if (!userId) throw new WsException('Not authenticated');

    const controllerId = this.teleprompterController.get(bookingId);
    if (controllerId !== client.id) {
      throw new WsException(
        'You do not currently hold teleprompter control. Request control first.',
      );
    }
  }

  // find a socket by userId within a specific session.
  private findSocketByUserId(bookingId: string, userId: string): Socket | null {
    const sessionSet = this.sessionSockets.get(bookingId);
    if (!sessionSet) return null;

    for (const socketId of sessionSet) {
      const participant = this.socketToParticipant.get(socketId);
      if (participant?.userId === userId) {
        return this.getSocket(socketId);
      }
    }
    return null;
  }

  // retrieve a connected socket by its ID.
  private getSocket(socketId: string): Socket | null {
    if (!this.server || !this.server.sockets) return null;
    const socketsMap = (
      this.server as unknown as { sockets: Map<string, Socket> }
    ).sockets;
    const socket = socketsMap?.get(socketId);
    return socket?.connected ? socket : null;
  }

  // extract userId from JWT token in handshake auth or query params.
  private async extractUserId(client: Socket): Promise<string | null> {
    const userIdFromQuery = client.handshake.query.userId as string;
    const token =
      (client.handshake.query.token as string) ||
      (client.handshake.auth?.token as string);

    const userIdFromToken = this.verifyTokenUserId(token);

    if (userIdFromQuery) {
      if (userIdFromToken && userIdFromToken !== userIdFromQuery) {
        this.logger.warn(
          `[/session] Rejected socket ${client.id} due to mismatched query.userId and JWT identity`,
        );
        return null;
      }

      this.logger.warn(
        `[/session] Deprecated query.userId auth used by socket ${client.id}; migrate client to JWT auth`,
      );

      return userIdFromToken ?? userIdFromQuery;
    }

    return userIdFromToken;
  }

  getSessionParticipantCount(bookingId: string): number {
    return this.sessionSockets.get(bookingId)?.size ?? 0;
  }

  getActiveSessions(): string[] {
    return Array.from(this.sessionSockets.keys());
  }

  private assignControlToNextParticipant(
    bookingId: string,
  ): SessionParticipant | null {
    const sessionSet = this.sessionSockets.get(bookingId);
    if (!sessionSet || sessionSet.size === 0) {
      return null;
    }

    const nextSocketId = Array.from(sessionSet).find((socketId) =>
      this.socketToParticipant.has(socketId),
    );
    if (!nextSocketId) {
      return null;
    }

    const nextParticipant = this.socketToParticipant.get(nextSocketId) || null;
    if (!nextParticipant) {
      return null;
    }

    this.teleprompterController.set(bookingId, nextSocketId);
    nextParticipant.hasControl = true;

    return nextParticipant;
  }

  private async getAuthorizedRole(
    bookingId: string,
    userId: string,
  ): Promise<'actor' | 'reader'> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (!booking) {
      throw new WsException(`Booking ${bookingId} not found`);
    }

    if (booking.actorUserId === userId) {
      return 'actor';
    }

    if (booking.readerUserId === userId) {
      return 'reader';
    }

    this.logger.warn(
      `[/session] Rejected unauthorized session join for user ${userId} on booking ${bookingId}`,
    );
    throw new WsException('You are not authorized to join this session');
  }

  private verifyTokenUserId(token?: string): string | null {
    if (!token) {
      return null;
    }

    try {
      const secret = this.configService.get<string>(
        'JWT_SECRET',
        'your-secret-key',
      );
      const payload = this.jwtService.verify(token, { secret });
      return payload.sub || payload.id || payload.userId || null;
    } catch {
      return null;
    }
  }
}
