import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateBookingDto {
  @ApiProperty({ description: 'Reader profile ID' })
  @IsUUID()
  @IsNotEmpty()
  readerProfileId: string;

  @ApiProperty({ description: 'Time slot ID to book' })
  @IsUUID()
  @IsNotEmpty()
  timeSlotId: string;

  @ApiProperty({ description: 'Session duration in minutes', example: 30 })
  @IsInt()
  @Min(15)
  sessionDurationMinutes: number;

  @ApiPropertyOptional({
    description: 'Whether to allow session extensions (default: true)',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  extensionAllowed?: boolean;
}

export class CancelBookingDto {
  @ApiPropertyOptional({ description: 'Reason for cancellation' })
  @IsOptional()
  @IsString()
  reason?: string;
}

export class GetAvailabilityQueryDto {
  @ApiProperty({
    description: 'Date in YYYY-MM-DD format',
    example: '2025-03-15',
  })
  @IsString()
  @IsNotEmpty()
  date: string;

  @ApiPropertyOptional({
    description: 'IANA timezone for display (e.g. America/New_York)',
    example: 'America/New_York',
  })
  @IsOptional()
  @IsString()
  timezone?: string;
}
