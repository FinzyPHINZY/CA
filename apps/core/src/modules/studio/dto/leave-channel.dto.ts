import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LeaveChannelDto {
  @ApiProperty({
    description: 'The Agora channel name to leave',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString({ message: 'Channel name must be a string' })
  @IsNotEmpty({ message: 'Channel name is required' })
  channelName: string;
}
