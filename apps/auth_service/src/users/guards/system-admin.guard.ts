import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { UserRole } from '@app/common';

@Injectable()
export class SystemAdminGuard implements CanActivate {
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
    if (!roles.includes(UserRole.SYSTEM_ADMIN)) {
      throw new ForbiddenException(
        'Only system administrators can perform this action',
      );
    }
    return true;
  }
}
