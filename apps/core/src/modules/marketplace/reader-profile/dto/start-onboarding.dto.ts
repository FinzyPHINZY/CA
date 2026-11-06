import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class StartOnboardingDto {
  @ApiProperty({
    description: 'IANA timezone string for the reader',
    example: 'America/New_York',
    required: false,
  })
  @IsString()
  @IsOptional()
  timezone?: string;
}
