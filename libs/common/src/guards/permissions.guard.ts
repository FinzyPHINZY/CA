import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '../enums/user-role.enum';
import { PERMISSIONS_KEY } from './permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Access denied');
    }

    // System admins have all permissions
    if (user.roles?.includes(UserRole.SYSTEM_ADMIN)) {
      return true;
    }

    const permissions: string[] = user.permissions ?? [];
    const hasPermission = requiredPermissions.some((p) =>
      permissions.includes(p),
    );
    if (!hasPermission) {
      throw new ForbiddenException(
        `Requires one of these permissions: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}
