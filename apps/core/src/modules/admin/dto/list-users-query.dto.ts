import {
  RecordingStatus,
  RecordingTypeEnum,
  RehearsalPartnerType,
  RehearsalStatus,
} from '@app/common';
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

export enum UserListRoleFilter {
  ACTOR = 'actor',
  READER = 'reader',
}

export enum UserListStatusFilter {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DEACTIVATED = 'deactivated',
  BANNED = 'banned',
}

export enum UserListSubscriptionStatusFilter {
  SUBSCRIBED = 'subscribed',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  INACTIVE = 'inactive',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export enum UserListSortBy {
  CREATED_AT = 'createdAt',
  NAME = 'name',
  EMAIL = 'email',
}

export enum UserListSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export class ListUsersQueryDto {
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
    description: 'Search users by full name or email',
    example: 'james@gmail.com',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: UserListRoleFilter,
    description: 'Filter by user role',
  })
  @IsOptional()
  @IsEnum(UserListRoleFilter)
  role?: UserListRoleFilter;

  @ApiPropertyOptional({
    enum: UserListStatusFilter,
    description: 'Filter by derived user status',
  })
  @IsOptional()
  @IsEnum(UserListStatusFilter)
  status?: UserListStatusFilter;

  @ApiPropertyOptional({
    enum: UserListSubscriptionStatusFilter,
    description: 'Filter by latest subscription status',
  })
  @IsOptional()
  @IsEnum(UserListSubscriptionStatusFilter)
  subscriptionStatus?: UserListSubscriptionStatusFilter;

  @ApiPropertyOptional({
    description: 'Filter users created on/after this date (ISO 8601)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter users created on/before this date (ISO 8601)',
    example: '2026-02-21',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    enum: UserListSortBy,
    default: UserListSortBy.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(UserListSortBy)
  sortBy?: UserListSortBy = UserListSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: UserListSortOrder,
    default: UserListSortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(UserListSortOrder)
  sortOrder?: UserListSortOrder = UserListSortOrder.DESC;
}

export enum UserRecordingSortBy {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  DURATION = 'duration',
  TITLE = 'title',
}

export class ListUserRecordingsQueryDto {
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
      'Search by title card, summary, project/script title, or scene heading',
    example: 'little women',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: RecordingStatus,
    description: 'Filter by recording status',
  })
  @IsOptional()
  @IsEnum(RecordingStatus)
  status?: RecordingStatus;

  @ApiPropertyOptional({
    enum: RecordingTypeEnum,
    description: 'Filter by recording type',
  })
  @IsOptional()
  @IsEnum(RecordingTypeEnum)
  type?: RecordingTypeEnum;

  @ApiPropertyOptional({
    description: 'Filter by project ID',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Filter by scene ID',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  sceneId?: string;

  @ApiPropertyOptional({
    description: 'Filter recordings created on/after this date (ISO 8601)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter recordings created on/before this date (ISO 8601)',
    example: '2026-02-21',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    enum: UserRecordingSortBy,
    default: UserRecordingSortBy.CREATED_AT,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(UserRecordingSortBy)
  sortBy?: UserRecordingSortBy = UserRecordingSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: UserListSortOrder,
    default: UserListSortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(UserListSortOrder)
  sortOrder?: UserListSortOrder = UserListSortOrder.DESC;
}

export enum UserRehearsalSortBy {
  CREATED_AT = 'createdAt',
  UPDATED_AT = 'updatedAt',
  STARTED_AT = 'startedAt',
  ENDED_AT = 'endedAt',
  SESSION_DURATION = 'sessionDurationSeconds',
}

export class ListUserRehearsalsQueryDto {
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
      'Search by AI partner details, project/script title, or scene heading',
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
    description: 'Filter by partner type',
  })
  @IsOptional()
  @IsEnum(RehearsalPartnerType)
  partnerType?: RehearsalPartnerType;

  @ApiPropertyOptional({
    description: 'Filter by project ID',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiPropertyOptional({
    description: 'Filter by scene ID',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  sceneId?: string;

  @ApiPropertyOptional({
    description: 'Filter rehearsals created on/after this date (ISO 8601)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({
    description: 'Filter rehearsals created on/before this date (ISO 8601)',
    example: '2026-02-21',
  })
  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @ApiPropertyOptional({
    enum: UserRehearsalSortBy,
    default: UserRehearsalSortBy.CREATED_AT,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(UserRehearsalSortBy)
  sortBy?: UserRehearsalSortBy = UserRehearsalSortBy.CREATED_AT;

  @ApiPropertyOptional({
    enum: UserListSortOrder,
    default: UserListSortOrder.DESC,
    description: 'Sort direction',
  })
  @IsOptional()
  @IsEnum(UserListSortOrder)
  sortOrder?: UserListSortOrder = UserListSortOrder.DESC;
}
