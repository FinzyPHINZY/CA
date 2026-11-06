import { SubscriptionPlan, SubscriptionStatus } from '@app/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum AdminSubscriptionSortBy {
  CREATED_AT = 'createdAt',
  RENEWAL_DATE = 'renewalDate',
  PLAN_NAME = 'planName',
  PLAN_STATUS = 'planStatus',
}

export enum AdminSubscriptionSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class ListSubscriptionsQueryDto {
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
    description: 'Search by Stripe subscription ID or plan name',
    example: 'sub_OLx9yZaBcDeFGHIJKLMN',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: SubscriptionPlan,
    description: 'Filter by plan',
  })
  @IsOptional()
  @IsEnum(SubscriptionPlan)
  plan?: SubscriptionPlan;

  @ApiPropertyOptional({
    enum: SubscriptionStatus,
    description: 'Filter by subscription status',
  })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @ApiPropertyOptional({
    description: 'Filter records created on/after this date',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter records created on/before this date',
    example: '2026-02-28',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    enum: AdminSubscriptionSortBy,
    default: AdminSubscriptionSortBy.CREATED_AT,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(AdminSubscriptionSortBy)
  sortBy?: AdminSubscriptionSortBy = AdminSubscriptionSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: AdminSubscriptionSortOrder,
    default: AdminSubscriptionSortOrder.DESC,
    description: 'Sort order',
  })
  @IsOptional()
  @IsEnum(AdminSubscriptionSortOrder)
  sortOrder?: AdminSubscriptionSortOrder = AdminSubscriptionSortOrder.DESC;
}
