import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { JwtAuthGuard, AUTH_SERVICE } from '@app/common';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription]),
    ConfigModule,
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
  controllers: [SubscriptionController],
  providers: [SubscriptionRepository, SubscriptionService, JwtAuthGuard],
  exports: [SubscriptionService, SubscriptionRepository],
})
export class SubscriptionModule {}
