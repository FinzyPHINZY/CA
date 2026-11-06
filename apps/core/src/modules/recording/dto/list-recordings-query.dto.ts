import { RecordingMode, RecordingStatus, RecordingTypeEnum } from '@app/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export class ListRecordingsQueryDto {
  @ApiPropertyOptional({
    description:
      'Filter by recording type. AI_PARTNER = AI rehearsal partner, READER = paid human reader session, SOLO = solo teleprompter or self-tape.',
    enum: RecordingTypeEnum,
    example: RecordingTypeEnum.SOLO,
  })
  @IsOptional()
  @IsEnum(RecordingTypeEnum)
  type?: RecordingTypeEnum;

  @ApiPropertyOptional({
    description: 'Filter by recording mode.',
    enum: RecordingMode,
    example: RecordingMode.SELF_TAPE,
  })
  @IsOptional()
  @IsEnum(RecordingMode)
  mode?: RecordingMode;

  @ApiPropertyOptional({
    description:
      'Filter by recording lifecycle status. pending = created but not started, recording = actively capturing, processing = transcoding/stitching, ready = playable, failed = pipeline error.',
    enum: RecordingStatus,
    example: RecordingStatus.READY,
  })
  @IsOptional()
  @IsEnum(RecordingStatus)
  status?: RecordingStatus;
}
