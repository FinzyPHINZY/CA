import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminPermission } from '../enums/admin-permission.enum';

const SYSTEM_ADMIN_ROLE = 'system_admin';
const APP_ADMIN_ROLE = 'app_admin';

/** Permissions that grant access to payments/subscription dashboard */
const SUBSCRIPTION_OR_BILLING_PERMISSIONS = [
  AdminPermission.SUBSCRIPTION_VIEW,
  AdminPermission.SUBSCRIPTION_EDIT,
  AdminPermission.BILLING_VIEW,
  AdminPermission.BILLING_EDIT,
];

@Injectable()
export class RequireSubscriptionOrBillingGuard implements CanActivate {
  private extractRoleCodes(user: any): string[] {
    if (Array.isArray(user?.roles)) {
      return user.roles.filter((r: unknown) => typeof r === 'string');
    }
    if (typeof user?.role?.code === 'string') return [user.role.code];
    return [];
  }

  private extractPermissions(user: any): string[] {
    if (Array.isArray(user?.permissions)) return user.permissions;
    return [];
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as any).user;
    const roles = this.extractRoleCodes(user);
    const permissions = this.extractPermissions(user);

    if (roles.includes(SYSTEM_ADMIN_ROLE)) {
      return true;
    }

    if (roles.includes(APP_ADMIN_ROLE)) {
      const hasRequiredPermission = SUBSCRIPTION_OR_BILLING_PERMISSIONS.some(
        (p) => permissions.includes(p),
      );
      if (hasRequiredPermission) {
        return true;
      }
    }

    throw new ForbiddenException(
      'Access denied. Requires system admin or app admin with subscription/billing permission.',
    );
  }
}
