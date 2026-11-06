// hazel ai orchestrator — rehearsal partner with pre-generated elevenlabs audio,
// browser-direct deepgram stt, and redis session state.

import {
  AUTH_SERVICE,
  AuthClientService,
  Character,
  CharacterRepository,
  RehearsalEvent,
  RehearsalEventRepository,
  Rehersal,
  RehersalRepository,
  Scene,
  SceneRepository,
  UsageRecord,
  UsageRecordRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CueEngineModule } from '../cue-engine/cue-engine.module';
import { ElevenLabsService } from './elevenlabs.service';
import { HazelController } from './hazel.controller';
import { HazelAudioPreGenerationService } from './hazel-audio-pregeneration.service';
import { HazelEventLoggerService } from './hazel-event-logger.service';
import { HazelRecordingService } from './hazel-recording.service';
import { HazelSceneLoaderService } from './hazel-scene-loader.service';
import { HazelSessionGateway } from './hazel-session.gateway';
import { HazelSessionService } from './hazel-session.service';
import { HazelUsageMeterService } from './hazel-usage-meter.service';
import { TurnSequenceBuilder } from './turn-sequence.builder';
import { TurnSequencerService } from './turn-sequencer.service';
import { VoiceMapperService } from './voice-mapper.service';

@Module({
  imports: [
    CueEngineModule,
    TypeOrmModule.forFeature([
      Character,
      Rehersal,
      RehearsalEvent,
      UsageRecord,
      Scene,
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
        name: 'CORE_SERVICE',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [configService.get<string>('RABBITMQ_URL')],
            queue: configService.get<string>('CORE_SERVICE_QUEUE'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [HazelController],
  providers: [
    // gateway
    HazelSessionGateway,
    // services
    HazelSessionService,
    HazelSceneLoaderService,
    TurnSequenceBuilder,
    VoiceMapperService,
    ElevenLabsService,
    HazelAudioPreGenerationService,
    TurnSequencerService,
    HazelEventLoggerService,
    HazelUsageMeterService,
    HazelRecordingService,
    AuthClientService,
    // repositories
    CharacterRepository,
    RehersalRepository,
    RehearsalEventRepository,
    UsageRecordRepository,
    SceneRepository,
  ],
  exports: [HazelSessionService],
})
export class HazelModule {}
