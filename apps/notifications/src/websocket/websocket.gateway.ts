import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Injectable, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

interface UserConnection {
  userId: string;
  socketId: string;
  connectedAt: Date;
}

interface ProgressEventPayload {
  taskId: string;
  userId: string;
  progressMessage: string;
  progress?: number; // 0-100
  step?: string;
}

interface TaskCompletedPayload {
  taskId: string;
  userId: string;
  resultMetadata: {
    status: 'success' | 'failed';
    message?: string;
    error?: string;
  };
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private readonly userConnections = new Map<string, Set<string>>(); // userId -> Set<socketId>
  private readonly socketToUser = new Map<string, string>(); // socketId -> userId

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.logger.log('WebSocket Gateway initialized');
    this.startQueueConsumers();
  }

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway afterInit');
  }

  async handleConnection(client: Socket) {
    try {
      // Extract userId from query parameter or auth token
      const userId = await this.extractUserId(client);

      if (!userId) {
        this.logger.warn(
          `Connection rejected: No userId provided for socket ${client.id}`,
        );
        client.disconnect();
        return;
      }

      // Store connection
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      this.userConnections.get(userId)!.add(client.id);
      this.socketToUser.set(client.id, userId);

      this.logger.log(
        `Client connected: ${client.id} for user ${userId}. Total connections for user: ${this.userConnections.get(userId)!.size}`,
      );

      // Send welcome message
      client.emit('connected', {
        message: 'Connected to notifications service',
        userId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        `Error handling connection: ${error.message}`,
        error.stack,
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = this.socketToUser.get(client.id);

    if (userId) {
      const userSockets = this.userConnections.get(userId);
      if (userSockets) {
        userSockets.delete(client.id);
        if (userSockets.size === 0) {
          this.userConnections.delete(userId);
        }
      }
      this.socketToUser.delete(client.id);

      this.logger.log(
        `Client disconnected: ${client.id} for user ${userId}. Remaining connections: ${userSockets?.size || 0}`,
      );
    } else {
      this.logger.warn(
        `Disconnected client ${client.id} not found in user mapping`,
      );
    }
  }

  /**
   * Emit progress event to a specific user
   */
  emitProgressEvent(userId: string, payload: ProgressEventPayload): void {
    const userSockets = this.userConnections.get(userId);

    if (!userSockets || userSockets.size === 0) {
      this.logger.warn(
        `No active connections for user ${userId}. Progress event not sent.`,
      );
      return;
    }

    const eventData = {
      type: 'analysis.progress',
      ...payload,
      timestamp: new Date().toISOString(),
    };

    // Emit to all sockets for this user
    if (!this.server) {
      this.logger.warn('WebSocket server not initialized');
      return;
    }

    userSockets.forEach((socketId) => {
      try {
        if (!this.server) {
          this.logger.warn('WebSocket server not initialized');
          return;
        }

        // When using @WebSocketGateway with namespace, this.server IS the namespace
        // The namespace has a sockets property which is a Map
        if (!this.server || !this.server.sockets) {
          this.logger.warn(
            `Namespace or sockets map not available for socket ${socketId}`,
          );
          return;
        }

        // Access sockets Map from namespace
        const socketsMap = (
          this.server as unknown as { sockets: Map<string, Socket> }
        ).sockets;
        const socket = socketsMap?.get(socketId);
        if (socket && socket.connected) {
          socket.emit('analysis.progress', eventData);
          this.logger.debug(
            `Progress event sent to ${socketId} for user ${userId}`,
          );
        } else {
          this.logger.warn(
            `Socket ${socketId} not found or disconnected for user ${userId}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Error emitting progress to socket ${socketId}: ${error.message}`,
          error.stack,
        );
      }
    });

    this.logger.log(
      `Progress event emitted to user ${userId} (${userSockets.size} connection(s)): ${payload.progressMessage}`,
    );
  }

  /**
   * Emit task completed event to a specific user
   */
  emitTaskCompleted(userId: string, payload: TaskCompletedPayload): void {
    const userSockets = this.userConnections.get(userId);

    if (!userSockets || userSockets.size === 0) {
      this.logger.warn(
        `No active connections for user ${userId}. Completion event not sent.`,
      );
      return;
    }

    const eventData = {
      type: 'analysis.completed',
      ...payload,
      timestamp: new Date().toISOString(),
    };

    // Emit to all sockets for this user
    if (!this.server) {
      this.logger.warn('WebSocket server not initialized');
      return;
    }

    userSockets.forEach((socketId) => {
      try {
        if (!this.server) {
          this.logger.warn('WebSocket server not initialized');
          return;
        }

        // When using @WebSocketGateway with namespace, this.server IS the namespace
        // So we can access sockets directly via the sockets Map
        if (!this.server || !this.server.sockets) {
          this.logger.warn(
            `Namespace or sockets map not available for socket ${socketId}`,
          );
          return;
        }

        // Access sockets Map from namespace
        const socketsMap = (
          this.server as unknown as { sockets: Map<string, Socket> }
        ).sockets;
        const socket = socketsMap?.get(socketId);
        if (socket && socket.connected) {
          socket.emit('analysis.completed', eventData);
          this.logger.debug(
            `Completion event sent to ${socketId} for user ${userId}`,
          );
        } else {
          this.logger.warn(
            `Socket ${socketId} not found or disconnected for user ${userId}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Error emitting completion to socket ${socketId}: ${error.message}`,
          error.stack,
        );
      }
    });

    this.logger.log(
      `Task completed event emitted to user ${userId} (${userSockets.size} connection(s)): ${payload.taskId}`,
    );
  }

  /**
   * Generic emit to a specific user by their userId.
   * Sends the event to all active socket connections for that user.
   */
  emitToUser(userId: string, event: string, payload: any): void {
    const userSockets = this.userConnections.get(userId);

    if (!userSockets || userSockets.size === 0) {
      this.logger.warn(
        `No active connections for user ${userId}. Event '${event}' not sent.`,
      );
      return;
    }

    if (!this.server || !this.server.sockets) {
      this.logger.warn('WebSocket server not initialized');
      return;
    }

    const eventData = {
      ...payload,
      timestamp: new Date().toISOString(),
    };

    const socketsMap = (
      this.server as unknown as { sockets: Map<string, Socket> }
    ).sockets;

    userSockets.forEach((socketId) => {
      try {
        const socket = socketsMap?.get(socketId);
        if (socket && socket.connected) {
          socket.emit(event, eventData);
        }
      } catch (error) {
        this.logger.error(
          `Error emitting '${event}' to socket ${socketId}: ${error.message}`,
        );
      }
    });

    this.logger.log(
      `Event '${event}' emitted to user ${userId} (${userSockets.size} connection(s))`,
    );
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
    return {
      event: 'pong',
      data: {
        message: 'pong',
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Extract userId from query parameter or JWT token
   */
  private async extractUserId(client: Socket): Promise<string | null> {
    // Try query parameter first
    const userIdFromQuery = client.handshake.query.userId as string;
    if (userIdFromQuery) {
      return userIdFromQuery;
    }

    // Try JWT token from query or auth header
    const token =
      (client.handshake.query.token as string) ||
      (client.handshake.auth?.token as string);

    if (token) {
      try {
        const secret = this.configService.get<string>(
          'JWT_SECRET',
          'your-secret-key',
        );
        const payload = this.jwtService.verify(token, { secret });
        return payload.sub || payload.id || payload.userId || null;
      } catch (error) {
        this.logger.warn(
          `Invalid token for socket ${client.id}: ${error.message}`,
        );
        return null;
      }
    }

    return null;
  }

  /**
   * Start queue consumers for analysis events
   */
  private startQueueConsumers() {
    // This will be implemented with the queue system
    this.logger.log(
      'Queue consumers will be started by NotificationQueueService',
    );
  }

  /**
   * Get active connections count for a user
   */
  getActiveConnectionsCount(userId: string): number {
    return this.userConnections.get(userId)?.size || 0;
  }

  /**
   * Get all active user IDs
   */
  getActiveUserIds(): string[] {
    return Array.from(this.userConnections.keys());
  }
}
