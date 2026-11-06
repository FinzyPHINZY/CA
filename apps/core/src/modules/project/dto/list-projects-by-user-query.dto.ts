import { ProjectStatus } from '@app/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export enum ProjectListSortBy {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  TITLE = 'title',
  SCENES_COUNT = 'scenesCount',
  RECORDINGS_COUNT = 'recordingsCount',
  REHEARSALS_COUNT = 'rehearsalsCount',
}

export enum ProjectListSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

/**
 * Query parameters for listing projects by user ID.
 * Supports pagination, search, filters, and sorting.
 */
export class ListProjectsByUserIdQueryDto {
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
      'Search by project title, description, or default character name',
    example: 'Little women',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: ProjectStatus,
    description: 'Filter by project status',
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({
    description: 'Minimum number of scenes',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  scenesMin?: number;

  @ApiPropertyOptional({
    description: 'Maximum number of scenes',
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  scenesMax?: number;

  @ApiPropertyOptional({
    description: 'Minimum number of recordings',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recordingsMin?: number;

  @ApiPropertyOptional({
    description: 'Maximum number of recordings',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recordingsMax?: number;

  @ApiPropertyOptional({
    description: 'Minimum number of rehearsals',
    example: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rehearsalsMin?: number;

  @ApiPropertyOptional({
    description: 'Maximum number of rehearsals',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  rehearsalsMax?: number;

  @ApiPropertyOptional({
    enum: ProjectListSortBy,
    default: ProjectListSortBy.CREATED_AT,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(ProjectListSortBy)
  sortBy?: ProjectListSortBy = ProjectListSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: ProjectListSortOrder,
    default: ProjectListSortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(ProjectListSortOrder)
  sortOrder?: ProjectListSortOrder = ProjectListSortOrder.DESC;
}
