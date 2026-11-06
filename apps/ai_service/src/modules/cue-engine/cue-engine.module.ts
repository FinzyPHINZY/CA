// Shared cue-detection sub-module. Extracted from Hazel so the teleprompter
// module (and any future rehearsal engine) can reuse the same cursor +
// jaccard + silence-detection + Deepgram stack without re-importing
// Hazel-specific TTS, voice mapping, or audio pre-generation code.

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CueDetectionService } from './cue-detection.service';
import { CursorCueDetectionService } from './cursor-cue-detection.service';
import { CursorStateService } from './cursor-state.service';
import { DeepgramService } from './deepgram.service';
import { SilenceDetectionService } from './silence-detection.service';

@Module({
  imports: [ConfigModule],
  providers: [
    CueDetectionService,
    CursorCueDetectionService,
    CursorStateService,
    DeepgramService,
    SilenceDetectionService,
  ],
  exports: [
    CueDetectionService,
    CursorCueDetectionService,
    CursorStateService,
    DeepgramService,
    SilenceDetectionService,
  ],
})
export class CueEngineModule {}
