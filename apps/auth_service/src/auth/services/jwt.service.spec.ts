/** biome-ignore-all lint/suspicious/noExplicitAny: test file */
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthService } from './jwt.service';
import { User } from '@app/common';

const makeUser = (overrides: Partial<User> = {}): User =>
  ({
    id: 'user-uuid-123',
    email: 'actor@example.com',
    role: { code: 'actor' } as any,
    roles: ['actor'],
    ...overrides,
  }) as User;

describe('JwtAuthService', () => {
  let service: JwtAuthService;
  let mockJwtService: jest.Mocked<JwtService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn(),
      decode: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn((key: string, fallback: string) => fallback),
    } as any;

    service = new JwtAuthService(mockJwtService, mockConfigService);
  });

  describe('generateAccessToken', () => {
    it('should sign with the correct payload and options', () => {
      const user = makeUser();
      mockJwtService.sign.mockReturnValue('access.token.here');

      const token = service.generateAccessToken(user);

      expect(token).toBe('access.token.here');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        { id: user.id, sub: user.id, email: user.email, roles: user.roles },
        expect.objectContaining({
          expiresIn: '15m',
          secret: 'your-secret-key',
        }),
      );
    });

    it('should use JWT_ACCESS_TOKEN_EXPIRES_IN from config when set', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'JWT_ACCESS_TOKEN_EXPIRES_IN') return '30m';
        if (key === 'JWT_SECRET') return 'my-secret';
        return undefined;
      });
      mockJwtService.sign.mockReturnValue('token');

      service.generateAccessToken(makeUser());

      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ expiresIn: '30m', secret: 'my-secret' }),
      );
    });
  });

  describe('generateRefreshToken', () => {
    it('should sign with refresh secret and longer expiry', () => {
      const user = makeUser();
      mockJwtService.sign.mockReturnValue('refresh.token.here');

      const token = service.generateRefreshToken(user);

      expect(token).toBe('refresh.token.here');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        { id: user.id, sub: user.id, email: user.email, roles: user.roles },
        expect.objectContaining({
          expiresIn: '7d',
          secret: 'refresh-secret',
        }),
      );
    });
  });

  describe('verifyToken', () => {
    it('should verify using JWT_SECRET and return the payload', () => {
      const payload = {
        id: 'u1',
        sub: 'u1',
        email: 'a@b.com',
        roles: ['actor'],
      };
      mockJwtService.verify.mockReturnValue(payload as any);

      const result = service.verifyToken('some.access.token');

      expect(result).toEqual(payload);
      expect(mockJwtService.verify).toHaveBeenCalledWith('some.access.token', {
        secret: 'your-secret-key',
      });
    });

    it('should propagate errors thrown by the underlying JwtService', () => {
      mockJwtService.verify.mockImplementation(() => {
        throw Object.assign(new Error('jwt expired'), {
          name: 'TokenExpiredError',
        });
      });

      expect(() => service.verifyToken('expired.token')).toThrow('jwt expired');
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify using JWT_REFRESH_SECRET', () => {
      const payload = {
        id: 'u1',
        sub: 'u1',
        email: 'a@b.com',
        roles: ['actor'],
      };
      mockJwtService.verify.mockReturnValue(payload as any);

      const result = service.verifyRefreshToken('some.refresh.token');

      expect(result).toEqual(payload);
      expect(mockJwtService.verify).toHaveBeenCalledWith('some.refresh.token', {
        secret: 'refresh-secret',
      });
    });

    it('should throw on an invalid signature', () => {
      mockJwtService.verify.mockImplementation(() => {
        throw Object.assign(new Error('invalid signature'), {
          name: 'JsonWebTokenError',
        });
      });

      expect(() => service.verifyRefreshToken('bad.token')).toThrow(
        'invalid signature',
      );
    });
  });

  describe('decodeToken', () => {
    it('should decode without verifying and return the claims', () => {
      const claims = { sub: 'u1', exp: 9999999999 };
      mockJwtService.decode.mockReturnValue(claims as any);

      const result = service.decodeToken('any.token.here');

      expect(result).toEqual(claims);
      expect(mockJwtService.decode).toHaveBeenCalledWith('any.token.here');
    });
  });

  describe('resolveUserIdFromPayload', () => {
    it('prefers sub when present', () => {
      expect(
        service.resolveUserIdFromPayload({
          sub: 'uuid-a',
          id: 'uuid-b',
          roles: [],
        } as any),
      ).toBe('uuid-a');
    });

    it('falls back to id when sub is missing', () => {
      expect(
        service.resolveUserIdFromPayload({
          id: 'uuid-only',
          roles: [],
        } as any),
      ).toBe('uuid-only');
    });

    it('returns undefined when neither sub nor id is a non-empty string', () => {
      expect(service.resolveUserIdFromPayload({ roles: [] } as any)).toBe(
        undefined,
      );
      expect(service.resolveUserIdFromPayload({ sub: '', id: '' } as any)).toBe(
        undefined,
      );
    });
  });
});
