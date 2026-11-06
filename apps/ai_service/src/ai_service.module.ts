import {
  Booking,
  AUTH_SERVICE,
  BullModule,
  Character,
  CharacterRepository,
  DatabaseModule,
  Genre,
  HealthModule,
  JwtAuthGuard,
  LoggerModule,
  Media,
  MediaModule,
  NOTIFICATIONS_SERVICE,
  Permission,
  Project,
  ProjectFlagged,
  ProjectRepository,
  QaConversation,
  QaMessage,
  Recording,
  RedisModule,
  RehearsalEvent,
  Rehersal,
  Scene,
  SceneRepository,
  Script,
  ScriptChunk,
  ScriptRepository,
  UsageRecord,
  User,
  UserRoleEntity,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as Joi from 'joi';
import { ScheduleModule } from '@nestjs/schedule';
import { AiServiceController } from './ai_service.controller';
import { AiServiceService } from './ai_service.service';
import { AiOrchestratorModule } from './modules/ai-orchestrator/ai-orchestrator.module';
import { BullBoardModule } from './modules/bull-board/bull-board.module';
import { HazelModule } from './modules/hazel/hazel.module';
import { TeleprompterModule } from './modules/teleprompter/teleprompter.module';
import { ScriptQaModule } from './modules/script-qa/script-qa.module';
import { SessionFileAnalysisModule } from './modules/session-file-analysis/session-file-analysis.module';
import { SessionReaperModule } from './modules/session-reaper/session-reaper.module';
import { ScriptAnalysisWorkerService } from './workers/script-analysis.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        AI_SERVICE_PORT: Joi.number().default(3002),
        RABBITMQ_URL: Joi.string().default('amqp://rabbitmq:5672'),
        AI_SERVICE_QUEUE: Joi.string().default('ai_service.queue'),
        NOTIFICATIONS_QUEUE: Joi.string().default('notifications.queue'),
        AUTH_SERVICE_HOST: Joi.string().default('auth_service'),
        AUTH_SERVICE_TCP_PORT: Joi.number().default(4001),
        CORE_SERVICE_QUEUE: Joi.string().default('core_service.queue'),
        SCRIPT_PARSER_QUEUE: Joi.string().default('script_parser.queue'),
        SCRIPT_PARSER_RESULTS_QUEUE: Joi.string().default('ai_service.queue'),
        GOOGLE_GEMINI_API_KEY: Joi.string().allow('').optional(),
        GEMINI_MODEL_NAME: Joi.string()
          .default('gemini-2.5-flash')
          .description('Gemini model to use (gemini-pro, gemini-2.5-flash)'),
        // LLM_PROVIDER: Joi.string()
        //   .valid('gemini', 'ollama')
        //   .default('gemini')
        //   .description(
        //     'LLM provider to use: gemini (Google Gemini API) or ollama (self-hosted)',
        //   ),
        // Ollama config commented out - using only Gemini for now
        // OLLAMA_BASE_URL: Joi.string()
        //   .default('http://localhost:11434')
        //   .description(
        //     'Ollama server base URL (default: http://localhost:11434)',
        //   ),
        // OLLAMA_MODEL: Joi.string()
        //   .default('llama3.1:8b')
        //   .description(
        //     'Ollama model to use (e.g., llama3.1:8b, llama3.1:70b, mistral:7b)',
        //   ),
        // OLLAMA_TEMPERATURE: Joi.number()
        //   .default(0.2)
        //   .description('Ollama temperature (0.0-1.0, default: 0.2)'),
        // OLLAMA_MAX_TOKENS: Joi.number()
        //   .default(8192)
        //   .description('Ollama maximum output tokens (default: 8192)'),
        RABBITMQ_ACK_TIMEOUT: Joi.number()
          .default(7200000)
          .description(
            'RabbitMQ consumer acknowledgment timeout in milliseconds (default: 2 hours). Increase for long-running script analysis jobs.',
          ),
        PDF_TEXT_THRESHOLD: Joi.number()
          .default(100)
          .description(
            'Minimum text length (characters) to consider PDF as text-based. PDFs with less text will use Gemini Vision fallback.',
          ),
        ENABLE_GEMINI_VISION_FALLBACK: Joi.boolean()
          .default(true)
          .description(
            'Enable fallback to Gemini Vision API for image-based PDFs when pdf-parse fails or returns minimal text.',
          ),
        ENABLE_NATIVE_PDF_CAPABILITY_DETECTION: Joi.boolean()
          .default(false)
          .description(
            'Enable metadata-only native PDF capability detection before extraction routing changes are rolled out.',
          ),
        ENABLE_NATIVE_PDF_FIRST_ROUTING: Joi.boolean()
          .default(false)
          .description(
            'Route strong/weak digital PDFs to native text extraction before external OCR-heavy extraction.',
          ),
        NATIVE_PDF_FIRST_ROUTING_ROLLOUT: Joi.number()
          .min(0)
          .max(100)
          .default(0)
          .description(
            'Percentage rollout for native-PDF-first routing once capability detection is available.',
          ),
        ENABLE_PYMUPDF_NATIVE_EXTRACTION_BRIDGE: Joi.boolean()
          .default(false)
          .description(
            'Allow ai_service to consume PyMuPDF native extraction payloads from script_parser.',
          ),
        PYMUPDF_NATIVE_EXTRACTION_BRIDGE_ROLLOUT: Joi.number()
          .min(0)
          .max(100)
          .default(0)
          .description(
            'Percentage rollout for consuming PyMuPDF native extraction payloads from script_parser.',
          ),
        ENABLE_PARSER_FIRST_ANALYSIS: Joi.boolean()
          .default(false)
          .description(
            'Defines the rollout flag for the parser-first script analysis path. Phase 0 only records this flag; Phase 1 will consume it for routing.',
          ),
        PARSER_FIRST_ANALYSIS_ROLLOUT: Joi.number()
          .min(0)
          .max(100)
          .default(0)
          .description(
            'Percentage rollout reserved for the parser-first analysis path once routing is wired in.',
          ),
        USE_EXTERNAL_PDF_EXTRACTOR: Joi.boolean()
          .default(false)
          .description(
            'Route PDF scripts through Adobe/Document AI extraction instead of legacy parser.',
          ),
        EXTERNAL_PDF_EXTRACTOR_ROLLOUT: Joi.number()
          .min(0)
          .max(100)
          .default(100)
          .description(
            'Percentage of PDF scripts routed through the external extractor when the feature flag is enabled.',
          ),
        ADOBE_PDF_CLIENT_ID: Joi.string().allow('').optional(),
        ADOBE_PDF_CLIENT_SECRET: Joi.string().allow('').optional(),
        ADOBE_PDF_SCOPES: Joi.string()
          .default('openid,AdobeID,DCAPI')
          .description(
            'Scopes requested for Adobe OAuth server-to-server flow',
          ),
        ADOBE_PDF_BASE_URL: Joi.string()
          .default('https://pdf-services.adobe.io')
          .description('Adobe PDF Services base URL'),
        GOOGLE_DOC_AI_PROJECT_ID: Joi.string().allow('').optional(),
        GOOGLE_DOC_AI_LOCATION: Joi.string().allow('').optional(),
        GOOGLE_DOC_AI_PROCESSOR_ID: Joi.string().allow('').optional(),
        GOOGLE_APPLICATION_CREDENTIALS: Joi.string().allow('').optional(),
        ENABLE_DEBUG_EXTRACTOR: Joi.boolean()
          .default(false)
          .description(
            'Allow the /debug/extract endpoint to run external extraction directly.',
          ),
        SKIP_SCRIPT_VALIDATION: Joi.boolean()
          .default(false)
          .description(
            'Temporarily bypass screenplay validation heuristics after extraction.',
          ),
        // Hazel AI Orchestrator (4.1.3)
        DEEPGRAM_API_KEY: Joi.string().allow('').optional(),
        DEEPGRAM_PROJECT_ID: Joi.string().allow('').optional(),
        ELEVENLABS_API_KEY: Joi.string().allow('').optional(),
        ELEVENLABS_DEFAULT_MODEL: Joi.string().default('eleven_turbo_v2_5'),
        HAZEL_MAX_SESSION_HOURS: Joi.number().default(4),
        HAZEL_DISCONNECT_GRACE_SECONDS: Joi.number().default(300),
        HAZEL_SILENCE_THRESHOLD_MS: Joi.number().default(5000),
        HAZEL_SILENCE_MIN_MATCH_RATIO: Joi.number().min(0).max(1).default(0.4),
        HAZEL_STUCK_AUTO_SKIP_MS: Joi.number().integer().min(500).max(30000)
          .default(3000),
        HAZEL_PREGEN_CONCURRENCY: Joi.number().default(5),
        HAZEL_NEUTRAL_VOICE_ID: Joi.string().optional(),
        REDIS_URL: Joi.string().default('redis://localhost:6379'),
        GEMINI_MAX_CONCURRENT: Joi.number().integer().min(1).default(3),
        AI_SERVICE_PREFETCH_COUNT: Joi.number().integer().min(1).default(5),
        USE_BULLMQ_DISPATCH: Joi.boolean().default(false),
        BULLMQ_STANDARD_CONCURRENCY: Joi.number().integer().min(1).default(3),
        BULLMQ_HEAVY_CONCURRENCY: Joi.number().integer().min(1).default(1),
      }),
    }),
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('NOTIFICATIONS_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: AUTH_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.TCP,
          options: {
            host: configService.get<string>(
              'AUTH_SERVICE_HOST',
              'auth_service',
            ),
            port: configService.get<number>('AUTH_SERVICE_TCP_PORT', 4001),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'SCRIPT_PARSER_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('SCRIPT_PARSER_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'CORE_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('CORE_SERVICE_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
    DatabaseModule.forRoot({
      entities: [
        Script,
        Character,
        Scene,
        Project,
        ProjectFlagged,
        Media,
        User,
        UserRoleEntity,
        Genre,
        Permission,
        Rehersal,
        Booking,
        RehearsalEvent,
        UsageRecord,
        Recording,
        ScriptChunk,
        QaConversation,
        QaMessage,
      ],
    }),
    TypeOrmModule.forFeature([Project]),
    RedisModule.forRoot(),
    BullModule.forRoot(),
    HealthModule,
    LoggerModule,
    MediaModule,
    AiOrchestratorModule,
    BullBoardModule,
    ScheduleModule.forRoot(),
    HazelModule,
    TeleprompterModule,
    ScriptQaModule,
    SessionFileAnalysisModule,
    SessionReaperModule,
  ],
  controllers: [AiServiceController],
  providers: [
    AiServiceService,
    ScriptAnalysisWorkerService,
    ProjectRepository,
    CharacterRepository,
    SceneRepository,
    ScriptRepository,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AiServiceModule {}
