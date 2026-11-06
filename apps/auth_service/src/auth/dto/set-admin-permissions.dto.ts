import { AdminPermission } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum } from 'class-validator';

export class SetAdminPermissionsDto {
  @ApiProperty({
    description:
      'List of permissions to grant to the app admin. Only system admins can set these. Replaces any existing permissions. Valid values: user_view, user_deactivate, user_ban, subscription_view, subscription_edit, project_view, project_edit, project_delete, access_flagged_content, content_moderate, content_delete, billing_view, billing_edit.',
    enum: AdminPermission,
    isArray: true,
    example: [
      AdminPermission.USER_VIEW,
      AdminPermission.USER_DEACTIVATE,
      AdminPermission.USER_BAN,
      AdminPermission.SUBSCRIPTION_VIEW,
      AdminPermission.SUBSCRIPTION_EDIT,
      AdminPermission.PROJECT_VIEW,
      AdminPermission.ACCESS_FLAGGED_CONTENT,
      AdminPermission.CONTENT_MODERATE,
      AdminPermission.CONTENT_DELETE,
      AdminPermission.BILLING_VIEW,
    ],
  })
  @IsArray()
  @IsEnum(AdminPermission, { each: true })
  permissions: string[];
}
