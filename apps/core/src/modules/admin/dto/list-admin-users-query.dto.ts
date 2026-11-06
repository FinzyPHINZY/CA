import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsInt,
  Min,
  Max,
  IsString,
  IsEnum,
  IsBooleanString,
} from 'class-validator';
import { UserRole } from '@app/common';

export enum AdminUserSortField {
  FULL_NAME = 'fullName',
  EMAIL = 'email',
  CREATED_AT = 'createdAt',
  ROLE = 'role',
}

export enum AdminUserSortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

/** Query DTO for GET /admin/users: search, sort, paginate, filter */
export class ListAdminUsersQueryDto {
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
    description: 'Items per page',
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Search by name or email (case-insensitive partial match)',
    example: 'jane@example.com',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Sort field',
    enum: AdminUserSortField,
    default: AdminUserSortField.CREATED_AT,
  })
  @IsOptional()
  @IsEnum(AdminUserSortField)
  sortBy?: AdminUserSortField = AdminUserSortField.CREATED_AT;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: AdminUserSortOrder,
    default: AdminUserSortOrder.DESC,
  })
  @IsOptional()
  @IsEnum(AdminUserSortOrder)
  sortOrder?: AdminUserSortOrder = AdminUserSortOrder.DESC;

  @ApiPropertyOptional({
    description: 'Filter by role (app_admin or system_admin)',
    enum: [UserRole.APP_ADMIN, UserRole.SYSTEM_ADMIN],
    example: UserRole.APP_ADMIN,
  })
  @IsOptional()
  @IsEnum(UserRole, {
    message: `role must be one of: ${UserRole.APP_ADMIN}, ${UserRole.SYSTEM_ADMIN}`,
  })
  role?: UserRole;

  @ApiPropertyOptional({
    description:
      'Filter by active status (true = not disabled and not deleted)',
    enum: ['true', 'false'],
    example: 'true',
  })
  @IsOptional()
  @IsBooleanString()
  active?: string;
}
