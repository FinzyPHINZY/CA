import './setup-crypto';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { FileServiceModule } from './file_service.module';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

async function bootstrap() {
  const app = await NestFactory.create(FileServiceModule, {
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);

  console.log('FILE_SERVICE ENV CHECK', {
    FILE_SERVICE_PORT: configService.get('FILE_SERVICE_PORT'),
    DB_HOST: configService.get('DB_HOST'),
    DB_NAME: configService.get('DB_NAME'),
    AUTH_SERVICE_HOST: configService.get('AUTH_SERVICE_HOST'),
    AUTH_SERVICE_TCP_PORT: configService.get('AUTH_SERVICE_TCP_PORT'),
    AWS_REGION: configService.get('AWS_REGION'),
    AWS_S3_BUCKET: configService.get('AWS_S3_BUCKET'),
    AWS_ACCESS_KEY_ID_PRESENT: !!configService.get('AWS_ACCESS_KEY_ID'),
    AWS_SECRET_ACCESS_KEY_PRESENT: !!configService.get('AWS_SECRET_ACCESS_KEY'),
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
  app.setGlobalPrefix('api');

  // Swagger Configuration
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ACR File Service API')
    .setDescription(
      'File service API documentation for file upload, download, streaming, and S3 storage management',
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
    .addTag('Files', 'File upload, download, and streaming operations')
    .addTag('Health', 'Service health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = configService.get<number>('FILE_SERVICE_PORT', 3004);
  await app.listen(port);
  const logger = app.get(Logger);
  logger.log(`File service is running on port ${port}`);
}
bootstrap();
