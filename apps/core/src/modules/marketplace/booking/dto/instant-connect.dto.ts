import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class InstantConnectDto {
  @ApiProperty({
    description: 'UUID of the reader profile to connect with',
    example: '33333333-3333-3333-3333-333333333333',
  })
  @IsUUID()
  @IsNotEmpty()
  readerProfileId: string;

  @ApiProperty({
    description:
      "Requested session duration in minutes. Must match one of the reader's configured session rates.",
    example: 30,
    minimum: 15,
  })
  @IsInt()
  @Min(15)
  sessionDurationMinutes: number;
}

export class DeclineInstantConnectDto {
  @ApiPropertyOptional({
    description: 'Optional reason for declining the request',
    example: 'Not available right now',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
