import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SessionRateItemDto {
  @ApiProperty({
    description: 'Session duration in minutes',
    example: 30,
  })
  @IsInt()
  @Min(5, { message: 'Minimum session duration is 5 minutes' })
  @Max(480, { message: 'Maximum session duration is 480 minutes (8 hours)' })
  durationMinutes: number;

  @ApiProperty({
    description: 'Price in cents (e.g., 1500 = $15.00)',
    example: 1500,
  })
  @IsInt()
  @Min(100, { message: 'Minimum price is 100 cents ($1.00)' })
  @Max(100000, { message: 'Maximum price is 100000 cents ($1000.00)' })
  priceCents: number;

  @ApiProperty({
    description: 'Currency code (ISO 4217)',
    example: 'USD',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(3)
  currency?: string;
}

export class UpdateSessionRatesDto {
  @ApiProperty({
    description: 'List of session rate tiers (duration + price)',
    type: [SessionRateItemDto],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'At least one session rate is required' })
  @ValidateNested({ each: true })
  @Type(() => SessionRateItemDto)
  rates: SessionRateItemDto[];
}
