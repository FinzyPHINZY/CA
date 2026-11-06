import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '@app/common';

const ADMIN_ROLES = [UserRole.APP_ADMIN, UserRole.SYSTEM_ADMIN];

@Injectable()
export class AdminGuard implements CanActivate {
  private extractRoleCodes(user: any): string[] {
    if (Array.isArray(user?.roles)) {
      return user.roles.filter((role: unknown) => typeof role === 'string');
    }
    const singleRoleCode =
      typeof user?.role?.code === 'string' ? user.role.code : undefined;
    return singleRoleCode ? [singleRoleCode] : [];
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as any).user;
    const roles = this.extractRoleCodes(user);
    const isAdmin = ADMIN_ROLES.some((role) => roles.includes(role));
    if (!isAdmin) {
      throw new ForbiddenException(
        'Only administrators can perform this action',
      );
    }
    return true;
  }
}
