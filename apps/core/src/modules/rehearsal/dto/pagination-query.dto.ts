import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsInt, Min, Max, IsString, IsEnum } from 'class-validator';
import { RehearsalPartnerType } from '@app/common';

export enum RehearsalSortField {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
}

export enum RehearsalSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class RehearsalPaginationQueryDto {
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
    description:
      'Search term to filter rehearsals. Searches across AI partner name and description.',
    example: 'character',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by rehearsal partner type',
    enum: RehearsalPartnerType,
    example: RehearsalPartnerType.USER,
  })
  @IsOptional()
  @IsEnum(RehearsalPartnerType)
  partnerType?: RehearsalPartnerType;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: RehearsalSortField,
    default: RehearsalSortField.CREATED_AT,
    example: RehearsalSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(RehearsalSortField)
  sortBy?: RehearsalSortField = RehearsalSortField.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: RehearsalSortOrder,
    default: RehearsalSortOrder.DESC,
    example: RehearsalSortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(RehearsalSortOrder)
  sortOrder?: RehearsalSortOrder = RehearsalSortOrder.DESC;
}
