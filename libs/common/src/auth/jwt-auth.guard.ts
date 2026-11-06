import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_SERVICE } from '../constants/services';
import { ClientProxy } from '@nestjs/microservices';
import { Request } from 'express';
import { firstValueFrom } from 'rxjs';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authClient: ClientProxy,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromRequest(request);
    if (!token) {
      throw new UnauthorizedException('Authentication token is missing');
    }
    try {
      const user = await firstValueFrom(
        this.authClient.send('auth.validateToken', { token }),
      );
      if (!user || !user.id) {
        throw new UnauthorizedException('User not found');
      }
      (request as any).user = user;
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid authentication token');
    }
  }

  private extractTokenFromRequest(request: Request): string | undefined {
    const authorizationHeader = request.headers['authorization'];
    if (!authorizationHeader) {
      return undefined;
    }
    const [type, token] = authorizationHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      return undefined;
    }
    return token;
  }
}
