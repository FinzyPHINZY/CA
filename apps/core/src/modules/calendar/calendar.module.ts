import {
  AUTH_SERVICE,
  Availability,
  Booking,
  CalendarEncryptionService,
  JwtAuthGuard,
  ReaderCalendarConnection,
  ReaderProfile,
  TimeSlot,
  User,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CalendarFeedController } from './calendar-feed.controller';
import { CalendarFeedService } from './calendar-feed.service';
import { CalendarOAuthController } from './calendar-oauth.controller';
import { CalendarSyncCronService } from './calendar-sync-cron.service';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarTokenRefresherService } from './calendar-token-refresher.service';
import { GoogleCalendarService } from './google-calendar.service';
import { IcsGeneratorService } from './ics-generator.service';
import { MicrosoftCalendarService } from './microsoft-calendar.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Booking,
      ReaderProfile,
      ReaderCalendarConnection,
      Availability,
      TimeSlot,
    ]),
    ClientsModule.registerAsync([
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
    ]),
  ],
  controllers: [CalendarFeedController, CalendarOAuthController],
  providers: [
    CalendarFeedService,
    IcsGeneratorService,
    GoogleCalendarService,
    MicrosoftCalendarService,
    CalendarEncryptionService,
    CalendarTokenRefresherService,
    CalendarSyncService,
    CalendarSyncCronService,
    JwtAuthGuard,
  ],
  exports: [CalendarFeedService, IcsGeneratorService, CalendarSyncService],
})
export class CalendarModule {}
