import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum ReaderSortField {
  RATING = 'rating',
  PRICE = 'price',
  SESSIONS = 'sessions',
  RELEVANCE = 'relevance',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class SearchReadersDto {
  @ApiPropertyOptional({
    description: 'Filter by genre/specialty',
    example: 'Drama',
  })
  @IsOptional()
  @IsString()
  genre?: string;

  @ApiPropertyOptional({
    description: 'Search by name or headline',
    example: 'Shakespeare',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Minimum session rate in cents',
    example: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minRate?: number;

  @ApiPropertyOptional({
    description: 'Maximum session rate in cents',
    example: 10000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxRate?: number;

  @ApiPropertyOptional({
    description: 'Minimum average rating (1-5)',
    example: 4,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({
    description: 'Filter by online status',
    example: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isOnline?: boolean;

  @ApiPropertyOptional({
    description:
      'Filter by in-session status. When set to false, excludes readers who are currently in an active session ' +
      '(i.e. have a booking with status "in_progress" or "pending_acceptance"). ' +
      'Recommended usage: ?isOnline=true&inSession=false to get readers available for instant connect.',
    example: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  inSession?: boolean;

  @ApiPropertyOptional({
    description: 'Page number (1-indexed)',
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    minimum: 1,
    maximum: 50,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Sort field',
    enum: ReaderSortField,
    default: ReaderSortField.RELEVANCE,
  })
  @IsOptional()
  @IsEnum(ReaderSortField)
  sortBy?: ReaderSortField = ReaderSortField.RELEVANCE;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: SortOrder,
    default: SortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;
}
