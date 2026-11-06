import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Scene,
  SceneRepository,
  Script,
  ScriptChunk,
  QaConversation,
  QaMessage,
} from '@app/common';
import { ChunkingService } from './services/chunking.service';
import { EmbeddingService } from './services/embedding.service';
import { RetrievalService } from './services/retrieval.service';
import { AnswerService } from './services/answer.service';
import { QaCacheService } from './services/qa-cache.service';
import { ConversationService } from './services/conversation.service';
import { QueryRouterService } from './services/query-router.service';
import { AggregateService } from './services/aggregate.service';
import { SuggestedQuestionsService } from './services/suggested-questions.service';
import { ScriptQaService } from './services/script-qa.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { QaQualityMonitorService } from './services/qa-quality-monitor.service';
import { ScriptEmbedHandler } from './handlers/script-embed.handler';
import { ScriptQaInternalController } from './script-qa.controller';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      ScriptChunk,
      QaConversation,
      QaMessage,
      Scene,
      Script,
    ]),
  ],
  controllers: [ScriptEmbedHandler, ScriptQaInternalController],
  providers: [
    ChunkingService,
    EmbeddingService,
    RetrievalService,
    AnswerService,
    QaCacheService,
    ConversationService,
    QueryRouterService,
    AggregateService,
    SuggestedQuestionsService,
    ScriptQaService,
    CircuitBreakerService,
    QaQualityMonitorService,
    SceneRepository,
  ],
  exports: [ChunkingService, EmbeddingService, ScriptQaService],
})
export class ScriptQaModule {}
