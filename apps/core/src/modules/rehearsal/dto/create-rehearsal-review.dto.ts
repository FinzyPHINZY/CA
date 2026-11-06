import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateRehearsalReviewDto {
  @ApiProperty({ description: 'Rating 1-5', example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({
    description: 'Review comment',
    example: 'Great rehearsal partner!',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class UpdateRehearsalReviewDto {
  @ApiPropertyOptional({ description: 'Updated rating 1-5', example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ description: 'Updated comment' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
