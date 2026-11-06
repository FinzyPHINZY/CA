import {
  ActorReview,
  AUTH_SERVICE,
  Availability,
  Booking,
  FavoriteReader,
  FeedbackRequest,
  JwtAuthGuard,
  NOTIFICATIONS_SERVICE,
  PaymentRecord,
  ReaderCalendarConnection,
  ReaderProfile,
  ReaderReview,
  ReaderSessionRate,
  ReaderSocialLink,
  ReaderSpecialty,
  ReaderWorkSample,
  TimeSlot,
  User,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CalendarModule } from '../calendar/calendar.module';
import { RehearsalModule } from '../rehearsal/rehearsal.module';
import { BookingController } from './booking/booking.controller';
import { BookingService } from './booking/booking.service';
import { BookingNotificationService } from './booking/booking-notification.service';
import { ConnectPaymentService } from './booking/connect-payment.service';
import { ConnectWebhookHandler } from './booking/connect-webhook.handler';
import { FeeCalculationService } from './booking/fee-calculation.service';
import { InstantConnectCronService } from './booking/instant-connect-cron.service';
import { InstantConnectService } from './booking/instant-connect.service';
import { RefundOrchestrationService } from './booking/refund-orchestration.service';
import { SessionLifecycleService } from './booking/session-lifecycle.service';
import { SettlementCronService } from './booking/settlement-cron.service';
import { SettlementService } from './booking/settlement.service';
import { SlotGenerationService } from './booking/slot-generation.service';
import { ReaderDiscoveryController } from './reader-discovery/reader-discovery.controller';
import { ReaderDiscoveryService } from './reader-discovery/reader-discovery.service';
import { ReaderProfileController } from './reader-profile/reader-profile.controller';
import { ReaderProfileService } from './reader-profile/reader-profile.service';
import { StripeConnectService } from './reader-profile/stripe-connect.service';
import { ActorReviewService } from './review/actor-review.service';
import { FeedbackNotificationService } from './review/feedback-notification.service';
import { ReviewController } from './review/review.controller';
import { ReviewService } from './review/review.service';
import { FeedbackReminderCronService } from './booking/feedback-reminder-cron.service';

@Module({
  imports: [
    CalendarModule,
    RehearsalModule,
    TypeOrmModule.forFeature([
      User,
      ReaderProfile,
      ReaderSessionRate,
      ReaderSpecialty,
      ReaderWorkSample,
      ReaderSocialLink,
      ReaderCalendarConnection,
      ReaderReview,
      ActorReview,
      FeedbackRequest,
      Booking,
      PaymentRecord,
      FavoriteReader,
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
    ]),
  ],
  controllers: [
    ReaderDiscoveryController,
    ReaderProfileController,
    BookingController,
    ReviewController,
  ],
  providers: [
    ReaderProfileService,
    StripeConnectService,
    ReaderDiscoveryService,
    BookingService,
    InstantConnectService,
    InstantConnectCronService,
    SlotGenerationService,
    FeeCalculationService,
    ConnectPaymentService,
    ConnectWebhookHandler,
    RefundOrchestrationService,
    SessionLifecycleService,
    SettlementService,
    SettlementCronService,
    ReviewService,
    ActorReviewService,
    FeedbackNotificationService,
    FeedbackReminderCronService,
    BookingNotificationService,
    JwtAuthGuard,
  ],
  exports: [
    ReaderProfileService,
    StripeConnectService,
    ReaderDiscoveryService,
    BookingService,
    InstantConnectService,
    SlotGenerationService,
    FeeCalculationService,
    ConnectPaymentService,
    ConnectWebhookHandler,
    RefundOrchestrationService,
    SessionLifecycleService,
    SettlementService,
    ReviewService,
    ActorReviewService,
    FeedbackNotificationService,
    BookingNotificationService,
  ],
})
export class MarketplaceModule {}
