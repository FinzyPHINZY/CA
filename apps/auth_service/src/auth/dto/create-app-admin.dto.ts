import { AdminPermission } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAppAdminDto {
  @ApiProperty({
    description:
      'Email address for the new app admin account (used to sign in).',
    example: 'admin@example.com',
    required: true,
  })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @ApiProperty({
    description: 'Display name for the new app admin (optional).',
    example: 'Jane Admin',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  fullName?: string;

  @ApiProperty({
    description:
      'Granular permissions for this Support Admin. Only system admins can set these. Omit for no permissions. Valid values: user_view, user_deactivate, user_ban, subscription_view, subscription_edit, project_view, project_edit, project_delete, access_flagged_content, content_moderate, content_delete, billing_view, billing_edit.',
    enum: AdminPermission,
    isArray: true,
    required: false,
    example: [
      AdminPermission.USER_VIEW,
      AdminPermission.USER_DEACTIVATE,
      AdminPermission.SUBSCRIPTION_VIEW,
      AdminPermission.PROJECT_VIEW,
      AdminPermission.ACCESS_FLAGGED_CONTENT,
      AdminPermission.CONTENT_MODERATE,
    ],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(AdminPermission, { each: true })
  permissions?: string[];
}
