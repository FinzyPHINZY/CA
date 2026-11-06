import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export enum AdminProjectTabFilter {
  ALL = 'all',
  FLAGGED = 'flagged',
  REVIEWED = 'reviewed',
}

export enum AdminProjectSortBy {
  NAME = 'name',
  UPLOADED_DATE = 'uploadedDate',
  CREATED_BY = 'createdBy',
  FLAGGED_AT = 'flaggedAt',
}

export enum AdminProjectSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class ListProjectsQueryDto {
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
    description: 'Search by project title, owner full name, or owner email',
    example: 'bessie',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: AdminProjectTabFilter,
    default: AdminProjectTabFilter.ALL,
    description: 'UI tab filter',
  })
  @IsOptional()
  @IsEnum(AdminProjectTabFilter)
  tab?: AdminProjectTabFilter = AdminProjectTabFilter.ALL;

  @ApiPropertyOptional({
    enum: AdminProjectSortBy,
    default: AdminProjectSortBy.UPLOADED_DATE,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(AdminProjectSortBy)
  sortBy?: AdminProjectSortBy = AdminProjectSortBy.UPLOADED_DATE;

  @ApiPropertyOptional({
    enum: AdminProjectSortOrder,
    default: AdminProjectSortOrder.DESC,
    description: 'Sort order',
  })
  @IsOptional()
  @IsEnum(AdminProjectSortOrder)
  sortOrder?: AdminProjectSortOrder = AdminProjectSortOrder.DESC;
}
