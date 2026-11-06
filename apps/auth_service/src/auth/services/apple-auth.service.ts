import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

export interface AppleUserInfo {
  id: string;
  email?: string;
  emailVerified: boolean;
  name?: {
    firstName?: string;
    lastName?: string;
  };
}

@Injectable()
export class AppleAuthService {
  private readonly clientId: string;
  private readonly teamId: string;
  private readonly keyId: string;
  private readonly privateKey: string;

  constructor(private readonly configService: ConfigService) {
    this.clientId = this.configService.get<string>('APPLE_CLIENT_ID') || '';
    this.teamId = this.configService.get<string>('APPLE_TEAM_ID') || '';
    this.keyId = this.configService.get<string>('APPLE_KEY_ID') || '';
    this.privateKey = this.configService.get<string>('APPLE_PRIVATE_KEY') || '';
  }

  async verifyIdentityToken(
    identityToken: string,
    authorizationCode: string,
  ): Promise<AppleUserInfo> {
    try {
      const decoded = jwt.decode(identityToken, { complete: true });
      if (!decoded || typeof decoded === 'string') {
        throw new UnauthorizedException('Invalid Apple identity token');
      }

      const payload = decoded.payload as jwt.JwtPayload;
      if (!payload.sub) {
        throw new UnauthorizedException('Missing user ID in Apple token');
      }

      return {
        id: payload.sub,
        email: payload.email,
        emailVerified:
          payload.email_verified === true || payload.email_verified === 'true',
        name: payload.name
          ? {
              firstName: payload.name.givenName,
              lastName: payload.name.familyName,
            }
          : undefined,
      };
    } catch (error) {
      throw new UnauthorizedException('Failed to verify Apple token');
    }
  }
}
