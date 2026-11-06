import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AvailabilityService } from './availability.service';
import { AvailabilityController } from './availability.controller';
import { JwtAuthGuard, AUTH_SERVICE } from '@app/common';
import { Availability, TimeSlot } from '@app/common';

@Module({
  imports: [
    TypeOrmModule.forFeature([Availability, TimeSlot]),
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
  controllers: [AvailabilityController],
  providers: [AvailabilityService, JwtAuthGuard],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
