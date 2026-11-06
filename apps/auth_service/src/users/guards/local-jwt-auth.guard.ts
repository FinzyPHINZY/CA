import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthService } from '../../auth/services/jwt.service';
import { UserRepository } from '@app/common';

@Injectable()
export class LocalJwtAuthGuard implements CanActivate {
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
      const user = await this.userRepository.findOne({
        where: { id: userId },
        withDeleted: true, // Include soft-deleted users to check status
      });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      // Check if user is disabled or soft-deleted
      if (user.disabled || user.deletedAt) {
        throw new UnauthorizedException('Account has been disabled or deleted');
      }
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
      if (error instanceof UnauthorizedException) {
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
