import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

const SESSION_CHAT_TTL_SECONDS = 6 * 60 * 60; // 6 hours

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  type: 'text' | 'file';
  content?: string;
  fileUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  timestamp: number;
}

@Injectable()
export class SessionChatService {
  private readonly logger = new Logger(SessionChatService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  private messagesKey(bookingId: string): string {
    return `session-chat:${bookingId}:messages`;
  }

  async addMessage(
    bookingId: string,
    partial: Omit<ChatMessage, 'id' | 'timestamp'>,
  ): Promise<ChatMessage> {
    const message: ChatMessage = {
      ...partial,
      id: randomUUID(),
      timestamp: Date.now(),
    };

    const key = this.messagesKey(bookingId);
    await this.redis.zadd(key, message.timestamp, JSON.stringify(message));
    await this.redis.expire(key, SESSION_CHAT_TTL_SECONDS);

    return message;
  }

  async getMessages(bookingId: string): Promise<ChatMessage[]> {
    const key = this.messagesKey(bookingId);
    const raw = await this.redis.zrangebyscore(key, '-inf', '+inf');
    return raw.map((r) => JSON.parse(r) as ChatMessage);
  }

  async deleteSessionMessages(bookingId: string): Promise<void> {
    const key = this.messagesKey(bookingId);
    await this.redis.del(key);
    this.logger.log(`Deleted chat messages for session ${bookingId}`);
  }
}
