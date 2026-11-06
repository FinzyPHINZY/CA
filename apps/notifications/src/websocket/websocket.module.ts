import { BookingRepository } from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { NotificationQueueService } from './notification-queue.service';
import { SessionChatService } from './session-chat.service';
import { TeleprompterGateway } from './teleprompter.gateway';
import { NotificationsGateway } from './websocket.gateway';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET', 'your-secret-key'),
        signOptions: { expiresIn: '15m' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    BookingRepository,
    NotificationsGateway,
    NotificationQueueService,
    SessionChatService,
    TeleprompterGateway,
  ],
  exports: [
    BookingRepository,
    NotificationsGateway,
    NotificationQueueService,
    SessionChatService,
    TeleprompterGateway,
  ],
})
export class WebSocketModule {}
