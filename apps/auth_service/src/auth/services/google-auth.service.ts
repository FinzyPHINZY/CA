import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import axios from 'axios';

export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly client: OAuth2Client;

  constructor(private readonly configService: ConfigService) {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
      if (clientId) {
      this.client = new OAuth2Client(clientId);
    }
  }


  private isIdToken(token: string): boolean {
    const parts = token.split('.');
    return parts.length === 3;
  }


  async verifyAccessToken(token: string): Promise<GoogleUserInfo> {
    try {
      const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
      if (!clientId) {
        throw new UnauthorizedException(
          'Google OAuth is not configured. GOOGLE_CLIENT_ID is missing.',
        );
      }

      if (this.isIdToken(token)) {
        return await this.verifyIdToken(token, clientId);
      } else {
        return await this.getUserInfoFromAccessToken(token);
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException(
        `Failed to verify Google token: ${error.message || 'Unknown error'}`,
      );
    }
  }


  private async verifyIdToken(
    idToken: string,
    clientId: string,
  ): Promise<GoogleUserInfo> {
    const ticket = await this.client.verifyIdToken({
      idToken: idToken,
      audience: clientId,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw new UnauthorizedException('Invalid Google ID token: No payload');
    }

    if (!payload.sub) {
      throw new UnauthorizedException(
        'Invalid Google ID token: Missing user ID',
      );
    }

    if (!payload.email) {
      throw new UnauthorizedException(
        'Invalid Google ID token: Email not provided',
      );
    }

    return {
      id: payload.sub,
      email: payload.email,
      verified_email: payload.email_verified || false,
      name: payload.name || '',
      given_name: payload.given_name || '',
      family_name: payload.family_name || '',
      picture: payload.picture || '',
    };
  }

  private async getUserInfoFromAccessToken(
    accessToken: string,
  ): Promise<GoogleUserInfo> {
    try {
      const response = await axios.get(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const userInfo = response.data;

      if (!userInfo.id) {
        throw new UnauthorizedException(
          'Invalid Google access token: Missing user ID',
        );
      }

      if (!userInfo.email) {
        throw new UnauthorizedException(
          'Invalid Google access token: Email not provided',
        );
      }

      return {
        id: userInfo.id,
        email: userInfo.email,
        verified_email: userInfo.verified_email || false,
        name: userInfo.name || '',
        given_name: userInfo.given_name || '',
        family_name: userInfo.family_name || '',
        picture: userInfo.picture || '',
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new UnauthorizedException(
            'Invalid or expired Google access token',
          );
        }
        throw new UnauthorizedException(
          `Failed to get user info from Google: ${error.message}`,
        );
      }
      throw error;
    }
  }
}
