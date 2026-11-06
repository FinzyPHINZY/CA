import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Require at least one of the given admin permissions.
 * SYSTEM_ADMIN bypasses (they have all permissions). APP_ADMIN must have the permission in their list.
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
