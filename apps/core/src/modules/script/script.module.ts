import {
  AUTH_SERVICE,
  Character,
  CharacterRepository,
  JwtAuthGuard,
  Recording,
  RecordingRepository,
  Rehersal,
  RehersalRepository,
  Scene,
  SceneRepository,
  Script,
  ScriptRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScriptController } from './script.controller';
import { ScriptService } from './script.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Script, Scene, Character, Rehersal, Recording]),
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
  controllers: [ScriptController],
  providers: [
    ScriptRepository,
    ScriptService,
    SceneRepository,
    CharacterRepository,
    RecordingRepository,
    RehersalRepository,
    JwtAuthGuard,
  ],
  exports: [ScriptService],
})
export class ScriptModule {}
