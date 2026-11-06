/**
 * Granular permissions for app admins (Support Admin).
 * Only SYSTEM_ADMIN can grant these; APP_ADMIN users have a subset stored on their account.
 */
export enum AdminPermission {
  // User management
  USER_VIEW = 'user_view',
  USER_DEACTIVATE = 'user_deactivate',
  USER_BAN = 'user_ban',
  SUBSCRIPTION_VIEW = 'subscription_view',
  SUBSCRIPTION_EDIT = 'subscription_edit',

  // Project management
  PROJECT_VIEW = 'project_view',
  PROJECT_EDIT = 'project_edit',
  PROJECT_DELETE = 'project_delete',
  ACCESS_FLAGGED_CONTENT = 'access_flagged_content',

  // Content moderation
  CONTENT_MODERATE = 'content_moderate',
  CONTENT_DELETE = 'content_delete',

  // Billings
  BILLING_VIEW = 'billing_view',
  BILLING_EDIT = 'billing_edit',
}

/** All permission values for SYSTEM_ADMIN bypass (they have all permissions) */
export const ALL_ADMIN_PERMISSIONS = Object.values(AdminPermission) as string[];
