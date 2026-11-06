import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

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
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async getMessages(bookingId: string): Promise<ChatMessage[]> {
    const key = `session-chat:${bookingId}:messages`;
    const raw = await this.redis.zrangebyscore(key, '-inf', '+inf');
    return raw.map((r) => JSON.parse(r) as ChatMessage);
  }
}
