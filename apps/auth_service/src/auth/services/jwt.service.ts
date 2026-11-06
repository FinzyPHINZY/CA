import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User } from '@app/common';

export interface TokenPayload {
  id: string;
  sub: string;
  email?: string;
  roles: string[];
}

@Injectable()
export class JwtAuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Tokens minted here include both `sub` and `id`. Some proxies, older clients,
   * or manual JWTs may only set one. Never pass `undefined` into UUID lookups —
   * Postgres/TypeORM can throw (surfacing as HTTP 500).
   */
  resolveUserIdFromPayload(
    payload: TokenPayload | Record<string, unknown>,
  ): string | undefined {
    const p = payload as Record<string, unknown>;
    const sub = p.sub;
    const id = p.id;
    if (typeof sub === 'string' && sub.length > 0) {
      return sub;
    }
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
    return undefined;
  }

  generateAccessToken(user: User): string {
    const payload: TokenPayload = {
      id: user.id,
      sub: user.id,
      email: user.email,
      roles: user.roles,
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.configService.get<string>(
        'JWT_ACCESS_TOKEN_EXPIRES_IN',
        '15m',
      ),
      secret: this.configService.get<string>('JWT_SECRET', 'your-secret-key'),
    } as any);
  }

  generateRefreshToken(user: User): string {
    const payload: TokenPayload = {
      id: user.id,
      sub: user.id,
      email: user.email,
      roles: user.roles,
    };
    return this.jwtService.sign(payload, {
      expiresIn: this.configService.get<string>(
        'JWT_REFRESH_TOKEN_EXPIRES_IN',
        '7d',
      ),
      secret: this.configService.get<string>(
        'JWT_REFRESH_SECRET',
        'refresh-secret',
      ),
    } as any);
  }

  verifyToken(token: string): TokenPayload {
    return this.jwtService.verify<TokenPayload>(token, {
      secret: this.configService.get<string>('JWT_SECRET', 'your-secret-key'),
    });
  }

  verifyRefreshToken(token: string): TokenPayload {
    return this.jwtService.verify<TokenPayload>(token, {
      secret: this.configService.get<string>(
        'JWT_REFRESH_SECRET',
        'refresh-secret',
      ),
    });
  }

  decodeToken(token: string): Record<string, any> {
    return this.jwtService.decode(token) as Record<string, any>;
  }
}
