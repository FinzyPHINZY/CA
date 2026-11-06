import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  QaConversation,
  QaMessage,
  QaMessageRole,
} from '@app/common';
import type { TurnPair } from '../prompts/answer-lookup.prompt';
import type { Citation } from './answer.service';

const SESSION_PREFIX = 'qa:session:';
const SESSION_TTL = 86400;
const HOT_WINDOW_SIZE = 5;

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(QaConversation)
    private readonly conversationRepo: Repository<QaConversation>,
    @InjectRepository(QaMessage)
    private readonly messageRepo: Repository<QaMessage>,
  ) {}

  async getOrCreateConversation(
    userId: string,
    scriptId: string,
  ): Promise<QaConversation> {
    const existing = await this.conversationRepo.findOne({
      where: { userId, scriptId, archivedAt: IsNull() },
    });

    if (existing) return existing;

    const conversation = this.conversationRepo.create({
      userId,
      scriptId,
    });
    return this.conversationRepo.save(conversation);
  }

  async addUserMessage(
    conversationId: string,
    content: string,
  ): Promise<QaMessage> {
    const message = this.messageRepo.create({
      conversationId,
      role: QaMessageRole.USER,
      content,
    });
    const saved = await this.messageRepo.save(message);
    await this.updateHotWindow(conversationId);
    return saved;
  }

  async addAssistantMessage(
    conversationId: string,
    content: string,
    metadata: {
      queryClass?: any;
      citations?: Citation[] | null;
      retrievalMetadata?: Record<string, any> | null;
      model?: string | null;
      latencyMs?: number | null;
      tokenInput?: number | null;
      tokenOutput?: number | null;
      error?: string | null;
    },
  ): Promise<QaMessage> {
    const message = this.messageRepo.create({
      conversationId,
      role: QaMessageRole.ASSISTANT,
      content,
      queryClass: metadata.queryClass ?? null,
      citations: metadata.citations as any,
      retrievalMetadata: metadata.retrievalMetadata ?? null,
      model: metadata.model ?? null,
      latencyMs: metadata.latencyMs ?? null,
      tokenInput: metadata.tokenInput ?? null,
      tokenOutput: metadata.tokenOutput ?? null,
      error: metadata.error ?? null,
    });
    const saved = await this.messageRepo.save(message);
    await this.updateHotWindow(conversationId);
    return saved;
  }

  async getRecentTurns(
    conversationId: string,
    limit = HOT_WINDOW_SIZE,
  ): Promise<TurnPair[]> {
    const cached = await this.redis.get(`${SESSION_PREFIX}${conversationId}`);
    if (cached) {
      try {
        const turns = JSON.parse(cached) as TurnPair[];
        return turns.slice(-limit);
      } catch {
        // fall through to DB
      }
    }

    return this.rebuildHotWindow(conversationId, limit);
  }

  async archiveAndReset(
    userId: string,
    scriptId: string,
  ): Promise<QaConversation> {
    const existing = await this.conversationRepo.findOne({
      where: { userId, scriptId, archivedAt: IsNull() },
    });

    if (existing) {
      existing.archivedAt = new Date();
      await this.conversationRepo.save(existing);
      await this.redis.del(`${SESSION_PREFIX}${existing.id}`);
    }

    const newConversation = this.conversationRepo.create({
      userId,
      scriptId,
    });
    return this.conversationRepo.save(newConversation);
  }

  async getConversationWithMessages(
    userId: string,
    scriptId: string,
  ): Promise<{ conversation: QaConversation; messages: QaMessage[] } | null> {
    const conversation = await this.conversationRepo.findOne({
      where: { userId, scriptId, archivedAt: IsNull() },
    });

    if (!conversation) return null;

    const messages = await this.messageRepo.find({
      where: { conversationId: conversation.id },
      order: { createdAt: 'ASC' },
    });

    return { conversation, messages };
  }

  async updateFeedback(
    messageId: string,
    score: number,
  ): Promise<void> {
    await this.messageRepo.update(messageId, { userFeedback: score });
  }

  private async rebuildHotWindow(
    conversationId: string,
    limit: number,
  ): Promise<TurnPair[]> {
    const messages = await this.messageRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
      select: ['role', 'content'],
    });

    const turns: TurnPair[] = [];
    for (let i = 0; i < messages.length - 1; i++) {
      if (
        messages[i].role === QaMessageRole.USER &&
        messages[i + 1]?.role === QaMessageRole.ASSISTANT
      ) {
        turns.push({
          user: messages[i].content,
          assistant: messages[i + 1].content,
        });
        i++;
      }
    }

    const recent = turns.slice(-limit);

    await this.redis.setex(
      `${SESSION_PREFIX}${conversationId}`,
      SESSION_TTL,
      JSON.stringify(recent),
    );

    return recent;
  }

  private async updateHotWindow(conversationId: string): Promise<void> {
    await this.rebuildHotWindow(conversationId, HOT_WINDOW_SIZE);
  }
}
