// OpenTelemetry must init before NestJS — only active when OTEL_ENABLED=true
import '../../../libs/common/src/telemetry/tracing';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AiServiceModule } from './ai_service.module';

async function bootstrap() {
  const app = await NestFactory.create(AiServiceModule, {
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);
  console.log('AI_SERVICE ENV CHECK', {
    USE_EXTERNAL_PDF_EXTRACTOR:
      configService.get<boolean>('USE_EXTERNAL_PDF_EXTRACTOR', false) &&
      configService.get<number>('EXTERNAL_PDF_EXTRACTOR_ROLLOUT', 0),
    ADOBE_PDF_CLIENT_ID: configService.get('ADOBE_PDF_CLIENT_ID')
      ? 'configured'
      : 'missing',
    ADOBE_PDF_CLIENT_SECRET: configService.get('ADOBE_PDF_CLIENT_SECRET')
      ? 'configured'
      : 'missing',
    GOOGLE_DOC_AI_PROJECT_ID:
      configService.get('GOOGLE_DOC_AI_PROJECT_ID') || 'missing',
    GOOGLE_DOC_AI_PROCESSOR_ID:
      configService.get('GOOGLE_DOC_AI_PROCESSOR_ID') || 'missing',
    ENABLE_DEBUG_EXTRACTOR: configService.get('ENABLE_DEBUG_EXTRACTOR', false),
    SKIP_SCRIPT_VALIDATION: configService.get('SKIP_SCRIPT_VALIDATION', false),
  });

  // RabbitMQ Microservice (jobs queue — receives ai.script-analysis from core)
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672')],
      queue: configService.get<string>('AI_SERVICE_QUEUE', 'ai_service.queue'),
      noAck: false,
      prefetchCount: configService.get<number>('AI_SERVICE_PREFETCH_COUNT', 5),
      queueOptions: {
        durable: true,
      },
      consumerOptions: {
        // Increase acknowledgment timeout to 2 hours (7200000 ms) to handle long-running script analysis
        // Default is 30 minutes (1800000 ms), but large scripts with many chunks and retries can take longer
        ackTimeout: configService.get<number>('RABBITMQ_ACK_TIMEOUT', 7200000), // 2 hours default
      },
      socketOptions: {
        heartbeatIntervalInSeconds: 60,
        reconnectTimeInSeconds: 5,
      },
    },
  });

  app.enableCors({
    origin: '*',
    credentials: true,
  });
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
    }),
  );

  const port = configService.get<number>('AI_SERVICE_PORT', 3002);
  app.setGlobalPrefix('api');

  // Swagger Configuration
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ACR AI Service API')
    .setDescription(
      'AI Service API documentation for AI-powered features including script analysis, character insights, and content generation',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Attach a valid JWT access token issued by the authentication service',
      },
      'access-token',
    )
    .addTag('AI', 'AI-powered features and analysis')
    .addTag(
      'Teleprompter Solo',
      'Speech-paced solo teleprompter runtime — speaker-agnostic. Issues ephemeral Deepgram session keys (`GET /api/teleprompter/deepgram-token`) and force-resets stuck Redis sessions (`DELETE /api/teleprompter/session/:rehearsalId`). The live cursor lives on the `/teleprompter` Socket.io namespace (not documented here — see TELEPROMPTER_FRONTEND_HANDOFF.md). Gated by `Feature.TELEPROMPTER`.',
    )
    .addTag('Health', 'Service health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // Start all microservices
  await app.startAllMicroservices();
  await app.listen(port);
}
bootstrap();
