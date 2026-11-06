import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class JoinChannelDto {
  @ApiProperty({
    description: 'The Agora channel name to join',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString({ message: 'Channel name must be a string' })
  @IsNotEmpty({ message: 'Channel name is required' })
  channelName: string;

  @ApiProperty({
    description:
      'The role for the user: publisher (send + receive) or subscriber (receive only)',
    enum: ['publisher', 'subscriber'],
    example: 'publisher',
    required: false,
  })
  @IsOptional()
  @IsEnum(['publisher', 'subscriber'], {
    message: 'Role must be either "publisher" or "subscriber"',
  })
  role?: 'publisher' | 'subscriber';
}
