import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class StartRecordingDto {
  @ApiProperty({
    description: 'The Agora channel name to start recording for',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString({ message: 'Channel name must be a string' })
  @IsNotEmpty({ message: 'Channel name is required' })
  channelName: string;

  @ApiProperty({
    description:
      'Recording mode: mix (composite, single file) or individual (per-user tracks)',
    enum: ['mix', 'individual'],
    example: 'mix',
    required: false,
  })
  @IsOptional()
  @IsEnum(['mix', 'individual'], {
    message: 'Mode must be either "mix" or "individual"',
  })
  mode?: 'mix' | 'individual';
}
