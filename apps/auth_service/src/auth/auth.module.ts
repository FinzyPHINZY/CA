import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import {
  AuditLog,
  AuditModule,
  DatabaseModule,
  ConfigModule,
  NOTIFICATIONS_SERVICE,
} from '@app/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  User,
  UserRoleEntity,
  Permission,
  PermissionRepository,
  Genre,
  UserRepository,
  Availability,
  TimeSlot,
  RefreshToken,
  RefreshTokenRepository,
} from '@app/common';
import { UsersModule } from '../users/users.module';
import { AppleAuthService } from './services/apple-auth.service';
import { GoogleAuthService } from './services/google-auth.service';
import { JwtAuthService } from './services/jwt.service';
import { PasswordService } from './services/password.service';

@Module({
  imports: [
    ConfigModule,
    AuditModule,
    DatabaseModule.forRoot({
      entities: [
        User,
        UserRoleEntity,
        Permission,
        AuditLog,
        Genre,
        Availability,
        TimeSlot,
        RefreshToken,
      ],
    }),
    TypeOrmModule.forFeature([User, Permission, AuditLog, RefreshToken]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) =>
        ({
          secret: configService.get<string>('JWT_SECRET', 'your-secret-key'),
          signOptions: {
            expiresIn: configService.get<string>(
              'JWT_ACCESS_TOKEN_EXPIRES_IN',
              '15m',
            ),
          },
        }) as any,
      inject: [ConfigService],
    }),
    ClientsModule.registerAsync([
      {
        name: NOTIFICATIONS_SERVICE,
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              configService.get<string>('RABBITMQ_URL', 'amqp://rabbitmq:5672'),
            ],
            queue: configService.get<string>(
              'NOTIFICATIONS_QUEUE',
              'notifications.queue',
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
    forwardRef(() => UsersModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    UserRepository,
    PermissionRepository,
    RefreshTokenRepository,
    PasswordService,
    JwtAuthService,
    GoogleAuthService,
    AppleAuthService,
  ],
  exports: [
    AuthService,
    UserRepository,
    PermissionRepository,
    RefreshTokenRepository,
    JwtAuthService,
    GoogleAuthService,
    AppleAuthService,
  ],
})
export class AuthModule {}
