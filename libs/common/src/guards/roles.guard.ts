/** biome-ignore-all lint/style/useImportType: <> */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  private extractRoleCodes(user: any): string[] {
    if (Array.isArray(user?.roles)) return user.roles;
    if (typeof user?.role === 'string') return [user.role];
    if (typeof user?.role?.code === 'string') return [user.role.code];
    return [];
  }

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const roleCodes = this.extractRoleCodes(user);
    if (!user || roleCodes.length === 0) {
      throw new ForbiddenException('Access denied');
    }

    const hasRole = requiredRoles.some((role) => roleCodes.includes(role));
    if (!hasRole) {
      throw new ForbiddenException(
        `Requires one of: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
