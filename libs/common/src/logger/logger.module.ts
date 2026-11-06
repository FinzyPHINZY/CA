import { Module } from '@nestjs/common';
import { LoggerModule as NestPinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    NestPinoLoggerModule.forRoot({
      pinoHttp: {
        transport: {
          target: 'pino-pretty',
          options: { singleLine: true },
        },
      },
    }),
  ],
})
export class LoggerModule {}
