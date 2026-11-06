import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export class GenerateTokenDto {
  @ApiProperty({
    description: 'The Agora channel name to generate a token for',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString({ message: 'Channel name must be a string' })
  @IsNotEmpty({ message: 'Channel name is required' })
  channelName: string;

  @ApiProperty({
    description:
      'The role for the token: publisher (send + receive) or subscriber (receive only)',
    enum: ['publisher', 'subscriber'],
    example: 'publisher',
  })
  @IsEnum(['publisher', 'subscriber'], {
    message: 'Role must be either "publisher" or "subscriber"',
  })
  role: 'publisher' | 'subscriber';
}
