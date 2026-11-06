import './setup-crypto';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AuthServiceModule } from './auth_service.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { InternalController } from './internal.controller';

async function bootstrap() {
  const app = await NestFactory.create(AuthServiceModule, {
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);

  console.log('AUTH_SERVICE ENV CHECK', {
    AUTH_PORT: configService.get('AUTH_PORT'),
    AUTH_SERVICE_TCP_PORT: configService.get('AUTH_SERVICE_TCP_PORT'),
    DB_HOST: configService.get('DB_HOST'),
    DB_NAME: configService.get('DB_NAME'),
    RABBITMQ_URL: configService.get('RABBITMQ_URL'),
    NOTIFICATIONS_QUEUE: configService.get('NOTIFICATIONS_QUEUE'),
    JWT_SECRET_PRESENT: !!configService.get('JWT_SECRET'),
    JWT_REFRESH_SECRET_PRESENT: !!configService.get('JWT_REFRESH_SECRET'),
    GOOGLE_CLIENT_ID_PRESENT: !!configService.get('GOOGLE_CLIENT_ID'),
    APPLE_CLIENT_ID_PRESENT: !!configService.get('APPLE_CLIENT_ID'),
  });
  app.connectMicroservice({
    transport: Transport.TCP,
    options: {
      host: '0.0.0.0',
      port: configService.get<number>('AUTH_SERVICE_TCP_PORT', 4001),
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
  app.useLogger(app.get(Logger));

  const authPort = configService.get<number>('AUTH_PORT', 3001);
  const ngrokUrl = configService.get<string>('NGROK_AUTH_URL', '');
  const productionUrl = configService.get<string>(
    'PRODUCTION_AUTH_API_URL',
    '',
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ACR Auth API')
    .setDescription(
      'Authentication service API documentation for email/password, OAuth (Google, Apple), and WebAuthn passkey authentication',
    )
    .setVersion('1.0.0')
    .addServer(`http://localhost:${authPort}`, 'Local Development')
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
              default: 'auth.cueactor.com',
              description: 'Production Auth API domain',
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
    .addTag('Authentication', 'User authentication and authorization')
    .addTag('Users', 'User profile management')
    .addTag('Health', 'Service health check endpoints')
    .build();
  app.setGlobalPrefix('api');

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const internalController = app.get(InternalController);
  internalController.setOpenapiDocument(document);

  await app.startAllMicroservices();
  await app.listen(authPort);
}
bootstrap();
