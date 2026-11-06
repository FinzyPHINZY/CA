import './setup-crypto';
import '../../../libs/common/src/telemetry/tracing';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { CoreModule } from './core.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { InternalController } from './internal.controller';
import { HttpMetricsInterceptor } from './modules/admin/http-metrics.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(CoreModule, { rawBody: true });
  const configService = app.get(ConfigService);

  console.log('CORE_SERVICE ENV CHECK', {
    CORE_PORT: configService.get('CORE_PORT'),
    DB_HOST: configService.get('DB_HOST'),
    DB_NAME: configService.get('DB_NAME'),
    RABBITMQ_URL: configService.get('RABBITMQ_URL'),
    AI_SERVICE_QUEUE: configService.get('AI_SERVICE_QUEUE'),
    CORE_SERVICE_QUEUE: configService.get('CORE_SERVICE_QUEUE'),
    AUTH_SERVICE_HOST: configService.get('AUTH_SERVICE_HOST'),
    AUTH_SERVICE_TCP_PORT: configService.get('AUTH_SERVICE_TCP_PORT'),
  });

  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672')],
      queue: configService.get<string>(
        'CORE_SERVICE_QUEUE',
        'core_service.queue',
      ),
      noAck: false,
      queueOptions: {
        durable: true,
      },
      socketOptions: {
        heartbeatIntervalInSeconds: 60,
        reconnectTimeInSeconds: 5,
      },
    },
  });

  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672')],
      queue: configService.get<string>(
        'DOMAIN_EVENTS_QUEUE',
        'domain.events.queue',
      ),
      noAck: false,
      queueOptions: {
        durable: true,
      },
      socketOptions: {
        heartbeatIntervalInSeconds: 60,
        reconnectTimeInSeconds: 5,
      },
    },
  });

  const allowedOrigins = configService
    .get<string>(
      'CORS_ORIGINS',
      'http://localhost:3000,http://localhost:3001,http://localhost:5173',
    )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (origin.endsWith('.ngrok-free.app')) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(app.get(HttpMetricsInterceptor));
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  const corePort = configService.get<number>('CORE_PORT', 3000);
  const ngrokUrl = configService.get<string>('NGROK_URL', '');
  const productionUrl = configService.get<string>('PRODUCTION_API_URL', '');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ACR Core API')
    .setDescription(
      'Core service API documentation for scripts, scenes, characters, media, subscriptions, payments, and content management',
    )
    .setVersion('1.0.0')
    .addServer(`http://localhost:${corePort}`, 'Local Development')
    .addServer(
      ngrokUrl || 'https://{subdomain}.ngrok-free.app',
      'Ngrok Tunnel',
      ngrokUrl
        ? {}
        : {
            subdomain: {
              default: 'your-subdomain',
              description: 'Your ngrok subdomain',
            },
          },
    )
    .addServer(
      productionUrl || 'https://{domain}',
      'Production',
      productionUrl
        ? {}
        : {
            domain: {
              default: 'api.cueactor.com',
              description: 'Production API domain',
            },
          },
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Attach a valid JWT access token issued by the authentication endpoints',
      },
      'access-token',
    )
    .addTag('Core', 'Core service endpoints')
    .addTag('Scripts', 'Script management and operations')
    .addTag('Scenes', 'Scene management')
    .addTag('Characters', 'Character management')
    .addTag('Analysis', 'Script analysis and insights')
    .addTag('Media', 'Media file management')
    .addTag('Upload', 'File upload operations')
    .addTag('Transcode', 'Media transcoding operations')
    .addTag('Subscriptions', 'Subscription management')
    .addTag('Payments', 'Payment processing')
    .addTag('Availability', 'User availability and scheduling')
    .addTag('Projects', 'Project management and operations')
    .addTag('Readers', 'Reader onboarding and profile management')
    .addTag('Reader Discovery', 'Search, browse, and favorite readers')
    .addTag('Bookings', 'Session booking, availability, and cancellations')
    .addTag('Reviews', 'Booking reviews and ratings')
    .addTag('Studio', 'Agora video session management and cloud recording')
    .addTag(
      'Session Shared Files',
      'In-call file sharing for booked reader sessions (Studio). Pure side-channel — no impact on rehearsal/turn state. Files are session-scoped and auto-cleaned 24h after session end. Optional script analysis runs through the Phase 4.0 parser pipeline with cross-session sha256 result caching.',
    )
    .addTag('Rehearsals', 'Rehearsal session creation and management')
    .addTag(
      'Teleprompter',
      'Teleprompter content + user preferences. Returns scene/script payloads formatted for teleprompter display (elements with type, characterName, lines, isActor flag) and CRUD for per-user teleprompter UI preferences (font size, scroll speed, blackout, highlight color).',
    )
    .addTag(
      'Teleprompter Solo',
      'Speech-paced solo teleprompter — speaker-agnostic. User reads a scene aloud and the cursor advances on dictation. Reuses the cue-engine (cursor + jaccard + silence + Deepgram). REST entry point: `POST /api/rehearsals/teleprompter` creates a SOLO/TELEPROMPTER rehearsal; runtime lives on ai_service at the `/teleprompter` WebSocket namespace. Gated by `Feature.TELEPROMPTER` (Premium + All-Access).',
    )
    .addTag('Recordings', 'Recording playback, variants, and management')
    .addTag('Admin', 'Admin operations (system_admin only)')
    .addTag('Health', 'Service health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const internalController = app.get(InternalController);
  internalController.setOpenapiDocument(document);

  await app.startAllMicroservices();
  await app.listen(corePort);
}
bootstrap();
