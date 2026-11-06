import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional } from 'class-validator';
import { DetectionMode } from '@app/common';

const DETECTION_MODES: DetectionMode[] = ['AUTO', 'LISTEN', 'MANUAL'];

export class UpdateRehearsalSettingsDto {
  @ApiProperty({
    enum: DETECTION_MODES,
    required: false,
    description: 'Per-session override for detection mode',
  })
  @IsOptional()
  @IsIn(DETECTION_MODES)
  detectionMode?: DetectionMode;

  @ApiProperty({
    required: false,
    description:
      'When true, the backend performs a loose advisory word-overlap check during the session and emits actor.line_mismatch events. When false, no overlap is computed.',
  })
  @IsOptional()
  @IsBoolean()
  wordTracking?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  autoRecord?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  loopMode?: boolean;

  @ApiProperty({
    required: false,
    description:
      'Voice overrides: characterId (UUID) → ElevenLabs voiceId. Merged into existing voiceMap. Set before prepare so Hazel uses correct voices from the start.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: {
      '423e4567-e89b-12d3-a456-426614174003': 'TxGEqnHWrfWFTfGW9XjX',
    },
  })
  @IsOptional()
  @IsObject()
  voiceMap?: Record<string, string>;
}
