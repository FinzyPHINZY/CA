import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthService } from '../../auth/services/jwt.service';
import { UserRepository } from '@app/common';

/**
 * Guard that ensures the authenticated user does NOT have a password set
 * Used for endpoints like set-password that should only be accessible
 * to OAuth users who haven't set a password yet
 */
@Injectable()
export class NoPasswordAuthGuard implements CanActivate {
  constructor(
    private readonly jwtAuthService: JwtAuthService,
    private readonly userRepository: UserRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromRequest(request);

    if (!token) {
      throw new UnauthorizedException('Authentication token is missing');
    }

    try {
      const payload = this.jwtAuthService.verifyToken(token);
      const userId = this.jwtAuthService.resolveUserIdFromPayload(payload);
      if (!userId) {
        throw new UnauthorizedException('Invalid authentication token');
      }
      const user = await this.userRepository.findById(userId);
      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      // Check if user already has a password
      if (user.password) {
        throw new BadRequestException(
          'Password already exists. Use change-password endpoint instead.',
        );
      }

      // Attach user to request
      (request as any).user = {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        roles: user.roles,
        avatar: user.avatar,
      };

      return true;
    } catch (error) {
      // Re-throw BadRequestException and UnauthorizedException as-is
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }
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
