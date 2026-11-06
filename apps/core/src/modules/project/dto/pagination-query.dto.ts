import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, Max, IsString, IsEnum } from 'class-validator';
import { ProjectStatus } from '@app/common';

export enum ProjectSortField {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  TITLE = 'title',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Page number (1-indexed)',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    minimum: 1,
    maximum: 100,
    default: 10,
    example: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Search term to filter projects by title or description',
    example: 'my project',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: ProjectSortField,
    default: ProjectSortField.CREATED_AT,
    example: ProjectSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(ProjectSortField)
  sortBy?: ProjectSortField = ProjectSortField.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: SortOrder,
    default: SortOrder.DESC,
    example: SortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;

  @ApiPropertyOptional({
    description: 'Filter projects by status',
    enum: ProjectStatus,
    example: ProjectStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;
}
