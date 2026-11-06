// Teleprompter module — speech-paced solo teleprompter.
// Reuses cue-engine (cursor + jaccard + silence-detection + Deepgram) without
// pulling in any Hazel TTS / voice / audio dependencies.

import {
  AUTH_SERVICE,
  AuthClientService,
  RehearsalEvent,
  RehearsalEventRepository,
  Rehersal,
  RehersalRepository,
  Scene,
  SceneRepository,
} from '@app/common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CueEngineModule } from '../cue-engine/cue-engine.module';
import { TeleprompterController } from './teleprompter.controller';
import { TeleprompterEventLoggerService } from './teleprompter-event-logger.service';
import { TeleprompterSequenceBuilder } from './teleprompter-sequence.builder';
import { TeleprompterSequencerService } from './teleprompter-sequencer.service';
import { TeleprompterSessionGateway } from './teleprompter-session.gateway';
import { TeleprompterSessionService } from './teleprompter-session.service';

@Module({
  imports: [
    CueEngineModule,
    TypeOrmModule.forFeature([RehearsalEvent, Rehersal, Scene]),
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
  controllers: [TeleprompterController],
  providers: [
    TeleprompterSessionGateway,
    TeleprompterSessionService,
    TeleprompterSequenceBuilder,
    TeleprompterSequencerService,
    TeleprompterEventLoggerService,
    AuthClientService,
    SceneRepository,
    RehersalRepository,
    RehearsalEventRepository,
  ],
  exports: [TeleprompterSessionService],
})
export class TeleprompterModule {}
