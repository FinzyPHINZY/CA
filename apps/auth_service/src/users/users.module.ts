import { DOMAIN_EVENTS_SERVICE, Genre, User } from '@app/common';
import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from './guards/admin.guard';
import { LocalJwtAuthGuard } from './guards/local-jwt-auth.guard';
import { NoPasswordAuthGuard } from './guards/no-password-auth.guard';
import { SystemAdminGuard } from './guards/system-admin.guard';
import { UserPreferencesService } from './user-preferences.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Genre]),
    forwardRef(() => AuthModule),
    // this is the domain events client for publishing user events to other services
    ClientsModule.registerAsync([
      {
        name: DOMAIN_EVENTS_SERVICE,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672'),
            ],
            queue: configService.get<string>(
              'DOMAIN_EVENTS_QUEUE',
              'domain.events.queue',
            ),
            queueOptions: {
              durable: true,
            },
            socketOptions: {
              heartbeatIntervalInSeconds: 60,
              reconnectTimeInSeconds: 5,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserPreferencesService,
    LocalJwtAuthGuard,
    NoPasswordAuthGuard,
    AdminGuard,
    SystemAdminGuard,
  ],
  exports: [
    UsersService,
    UserPreferencesService,
    LocalJwtAuthGuard,
    NoPasswordAuthGuard,
    AdminGuard,
    SystemAdminGuard,
  ],
})
export class UsersModule {}
