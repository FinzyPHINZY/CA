import './setup-crypto';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NotificationsServiceModule } from './notifications_service.module';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';

async function bootstrap() {
  const app = await NestFactory.create(NotificationsServiceModule, {
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);

  // Log key environment values (masked) to verify configuration
  console.log('NOTIFICATIONS_SERVICE ENV CHECK', {
    NOTIFICATIONS_SERVICE_PORT: configService.get('NOTIFICATIONS_SERVICE_PORT'),
    NOTIFICATIONS_TCP_PORT: configService.get('NOTIFICATIONS_TCP_PORT'),
    DB_HOST: configService.get('DB_HOST'),
    DB_NAME: configService.get('DB_NAME'),
    RABBITMQ_URL: configService.get('RABBITMQ_URL'),
    NOTIFICATIONS_QUEUE: configService.get('NOTIFICATIONS_QUEUE'),
    EMAIL_ENABLED: configService.get('EMAIL_ENABLED'),
    SMTP_HOST_PRESENT: !!configService.get('SMTP_HOST'),
    SMTP_USER_PRESENT: !!configService.get('SMTP_USER'),
  });

  // // TCP Microservice (internal)
  // app.connectMicroservice({
  //   transport: Transport.TCP,
  //   options: {
  //     host: '0.0.0.0',
  //     port: configService.get<number>('NOTIFICATIONS_TCP_PORT', 4004),
  //   },
  // });

  // RabbitMQ Microservice (jobs queue)
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672')],
      queue: configService.get<string>(
        'NOTIFICATIONS_QUEUE',
        'notifications.queue',
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
  const port = configService.get<number>('NOTIFICATIONS_SERVICE_PORT', 3003);
  app.setGlobalPrefix('api');

  // Swagger Configuration
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ACR Notifications Service API')
    .setDescription(
      'Notifications service API documentation for email notifications, push notifications, and message queue integration',
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
    .addTag('Notifications', 'Notification management and sending')
    .addTag('Health', 'Service health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.startAllMicroservices();
  await app.listen(port);
  const logger = app.get(Logger);
  logger.log(`Notifications service is running on port ${port}`);
}
bootstrap();
