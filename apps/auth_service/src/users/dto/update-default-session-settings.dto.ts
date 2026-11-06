import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { DetectionMode } from '@app/common';

const DETECTION_MODES: DetectionMode[] = ['AUTO', 'LISTEN', 'MANUAL'];

export class UpdateDefaultSessionSettingsDto {
  @ApiProperty({ enum: DETECTION_MODES, required: false })
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
}
