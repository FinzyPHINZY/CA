import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsString,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { NotificationType } from '@app/common';

export enum NotificationSortField {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  TITLE = 'title',
  READ = 'read',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class NotificationPaginationQueryDto {
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
      'Search term to filter notifications by title or body (case-insensitive)',
    example: 'analysis',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by notification type',
    enum: NotificationType,
    example: NotificationType.SCRIPT_ANALYSIS,
  })
  @IsOptional()
  @IsEnum(NotificationType)
  notificationType?: NotificationType;

  @ApiPropertyOptional({
    description: 'Filter by read status',
    type: Boolean,
    example: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  read?: boolean;

  @ApiPropertyOptional({
    description: 'Field to sort by',
    enum: NotificationSortField,
    default: NotificationSortField.CREATED_AT,
    example: NotificationSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(NotificationSortField)
  sortBy?: NotificationSortField = NotificationSortField.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: SortOrder,
    default: SortOrder.DESC,
    example: SortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;
}
