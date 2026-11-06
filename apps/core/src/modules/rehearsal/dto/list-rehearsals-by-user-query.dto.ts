import { RehearsalPartnerType, RehearsalStatus } from '@app/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export enum RehearsalListSortBy {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  STARTED_AT = 'startedAt',
  ENDED_AT = 'endedAt',
  SESSION_DURATION = 'sessionDurationSeconds',
}

export enum RehearsalListSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

/**
 * Query parameters for listing rehearsals by user ID.
 * Supports pagination, search, filters, and sorting.
 */
export class ListRehearsalsByUserIdQueryDto {
  @ApiPropertyOptional({ example: 1, default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description:
      'Search by AI partner name/description, project/script title, scene heading, or partner user name/email',
    example: 'hazel',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: RehearsalStatus,
    description: 'Filter by rehearsal status',
  })
  @IsOptional()
  @IsEnum(RehearsalStatus)
  status?: RehearsalStatus;

  @ApiPropertyOptional({
    enum: RehearsalPartnerType,
    description: 'Filter by partner type (USER or AI)',
  })
  @IsOptional()
  @IsEnum(RehearsalPartnerType)
  partnerType?: RehearsalPartnerType;

  @ApiPropertyOptional({ description: 'Filter by project ID', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Filter by scene ID', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sceneId?: string;

  @ApiPropertyOptional({
    description: 'Filter rehearsals created on or after this date (YYYY-MM-DD)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    description:
      'Filter rehearsals created on or before this date (YYYY-MM-DD)',
    example: '2026-02-21',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    enum: RehearsalListSortBy,
    default: RehearsalListSortBy.CREATED_AT,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(RehearsalListSortBy)
  sortBy?: RehearsalListSortBy = RehearsalListSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: RehearsalListSortOrder,
    default: RehearsalListSortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(RehearsalListSortOrder)
  sortOrder?: RehearsalListSortOrder = RehearsalListSortOrder.DESC;
}
