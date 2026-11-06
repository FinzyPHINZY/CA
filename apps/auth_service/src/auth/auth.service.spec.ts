/** biome-ignore-all lint/suspicious/noExplicitAny: test file */
import {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { RefreshToken } from '@app/common';

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

const makeUser = (overrides: any = {}) => ({
  id: 'user-uuid-1',
  email: 'actor@example.com',
  fullName: 'Test Actor',
  phoneNumber: null,
  role: { code: 'actor' },
  roles: ['actor'],
  permissions: [],
  avatar: null,
  emailVerified: true,
  timezone: 'UTC',
  disabled: false,
  deletedAt: null,
  deactivationReason: null,
  deactivatedAt: null,
  reactivationReason: null,
  reactivatedAt: null,
  ...overrides,
});

const makeRefreshToken = (overrides: any = {}): RefreshToken =>
  ({
    id: 'rt-uuid-1',
    userId: 'user-uuid-1',
    tokenHash: hash('raw.refresh.token'),
    family: 'family-uuid-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: undefined,
    ...overrides,
  }) as RefreshToken;

const RAW_REFRESH_TOKEN = 'raw.refresh.token';
const RAW_ACCESS_TOKEN = 'raw.access.token';
const MOCK_EXP = Math.floor(Date.now() / 1000) + 604800; // 7d from now

const makeMockUserRepo = () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  save: jest.fn(),
});

const makeMockRtRepo = () => ({
  revokeByHash: jest.fn().mockResolvedValue(undefined),
  revokeAllByFamily: jest.fn().mockResolvedValue(undefined),
  revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  createEntity: jest.fn().mockResolvedValue(makeRefreshToken()),
});

const makeMockJwtService = () => ({
  generateAccessToken: jest.fn().mockReturnValue(RAW_ACCESS_TOKEN),
  generateRefreshToken: jest.fn().mockReturnValue(RAW_REFRESH_TOKEN),
  verifyToken: jest.fn(),
  verifyRefreshToken: jest.fn().mockReturnValue({
    sub: 'user-uuid-1',
    id: 'user-uuid-1',
    email: 'actor@example.com',
    roles: ['actor'],
  }),
  resolveUserIdFromPayload: jest.fn((payload: any) => {
    if (typeof payload?.sub === 'string' && payload.sub.length > 0) {
      return payload.sub;
    }
    if (typeof payload?.id === 'string' && payload.id.length > 0) {
      return payload.id;
    }
    return undefined;
  }),
  decodeToken: jest.fn().mockReturnValue({ exp: MOCK_EXP }),
});

const makeMockAuditService = () => ({
  log: jest.fn().mockResolvedValue(undefined),
});

const makeMockPasswordService = () => ({
  comparePassword: jest.fn(),
  hashPassword: jest.fn().mockResolvedValue('hashed-password'),
});

const makeMockNotifications = () => ({
  emit: jest.fn(),
});

const makeMockManager = (userRepo: any, rtRepo?: any) => ({
  getRepository: jest.fn((entity: any) => {
    if (entity === RefreshToken) {
      return {
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(makeRefreshToken()),
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        save: jest.fn().mockResolvedValue(makeRefreshToken()),
        create: jest.fn().mockImplementation((data: any) => data),
        ...(rtRepo ?? {}),
      };
    }
    return userRepo;
  }),
});

const buildService = (overrides: any = {}) => {
  const userRepo = overrides.userRepo ?? makeMockUserRepo();
  const permRepo = overrides.permRepo ?? { findByCodes: jest.fn() };
  const rtRepo = overrides.rtRepo ?? makeMockRtRepo();
  const auditService = overrides.auditService ?? makeMockAuditService();
  const passwordService =
    overrides.passwordService ?? makeMockPasswordService();
  const jwtAuthService = overrides.jwtAuthService ?? makeMockJwtService();
  const googleService = overrides.googleService ?? {};
  const appleService = overrides.appleService ?? {};
  const dataSource = overrides.dataSource ?? { transaction: jest.fn() };
  const notifications = overrides.notifications ?? makeMockNotifications();

  const service = new AuthService(
    userRepo as any,
    permRepo as any,
    rtRepo as any,
    auditService as any,
    passwordService as any,
    jwtAuthService as any,
    googleService as any,
    appleService as any,
    dataSource as any,
    notifications as any,
  );

  return {
    service,
    userRepo,
    permRepo,
    rtRepo,
    auditService,
    passwordService,
    jwtAuthService,
    dataSource,
    notifications,
  };
};

describe('AuthService', () => {
  describe('generateAuthResponse', () => {
    it('should create a RefreshToken record and return both tokens', async () => {
      const { service, rtRepo, jwtAuthService } = buildService();
      const user = makeUser();

      const result = await service.generateAuthResponse(user as any);

      expect(jwtAuthService.generateAccessToken).toHaveBeenCalledWith(user);
      expect(jwtAuthService.generateRefreshToken).toHaveBeenCalledWith(user);
      expect(rtRepo.createEntity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          tokenHash: hash(RAW_REFRESH_TOKEN),
          expiresAt: new Date(MOCK_EXP * 1000),
        }),
      );
      expect(result.data.accessToken).toBe(RAW_ACCESS_TOKEN);
      expect(result.data.refreshToken).toBe(RAW_REFRESH_TOKEN);
    });

    it('should use a new family UUID when no family is provided', async () => {
      const { service, rtRepo } = buildService();

      await service.generateAuthResponse(makeUser() as any);

      const call = rtRepo.createEntity.mock.calls[0][0];
      expect(call.family).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('should preserve the provided family when rotating', async () => {
      const { service, rtRepo } = buildService();

      await service.generateAuthResponse(
        makeUser() as any,
        undefined,
        'msg',
        'existing-family-uuid',
      );

      expect(rtRepo.createEntity).toHaveBeenCalledWith(
        expect.objectContaining({ family: 'existing-family-uuid' }),
      );
    });

    it('should use the manager repository when inside a transaction', async () => {
      const { service } = buildService();
      const user = makeUser();
      const managerRtRepo = {
        save: jest.fn().mockResolvedValue(makeRefreshToken()),
        create: jest.fn().mockImplementation((d: any) => d),
      };
      const mockManager = makeMockManager(makeMockUserRepo(), managerRtRepo);

      await service.generateAuthResponse(user as any, mockManager as any);

      expect(managerRtRepo.save).toHaveBeenCalled();
    });
  });

  describe('refreshToken', () => {
    const setupTransaction = (
      storedToken: RefreshToken | null,
      dbUser: any = makeUser(),
    ) => {
      const userRepo = makeMockUserRepo();
      userRepo.findOne.mockResolvedValue(dbUser);

      const rtQb = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(storedToken),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      };
      const rtManagerRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(rtQb),
        save: jest.fn().mockResolvedValue(storedToken),
        create: jest.fn().mockImplementation((d: any) => d),
      };

      const mockManager = {
        getRepository: jest.fn((entity: any) => {
          if (entity === RefreshToken) return rtManagerRepo;
          return userRepo;
        }),
      };

      const dataSource = {
        transaction: jest
          .fn()
          .mockImplementation(async (cb: any) => cb(mockManager)),
      };

      return { userRepo, rtQb, rtManagerRepo, mockManager, dataSource };
    };

    it('should rotate the token and return new credentials on happy path', async () => {
      const storedToken = makeRefreshToken();
      const { dataSource, rtManagerRepo } = setupTransaction(storedToken);

      const { service } = buildService({ dataSource });
      const result = await service.refreshToken(RAW_REFRESH_TOKEN);

      expect(rtManagerRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      );
      expect(result.data.accessToken).toBe(RAW_ACCESS_TOKEN);
      expect(result.data.refreshToken).toBe(RAW_REFRESH_TOKEN);
    });

    it('should preserve the family during rotation', async () => {
      const storedToken = makeRefreshToken({ family: 'original-family' });

      const savedEntities: any[] = [];
      const rtManagerRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          setLock: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(storedToken),
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({}),
        }),
        save: jest.fn().mockImplementation((e: any) => {
          savedEntities.push(e);
          return e;
        }),
        create: jest.fn().mockImplementation((d: any) => d),
      };

      const userRepo = makeMockUserRepo();
      userRepo.findOne.mockResolvedValue(makeUser());

      const mockManager = {
        getRepository: jest.fn((entity: any) => {
          if (entity === RefreshToken) return rtManagerRepo;
          return userRepo;
        }),
      };
      const dataSource = {
        transaction: jest
          .fn()
          .mockImplementation(async (cb: any) => cb(mockManager)),
      };

      const { service } = buildService({ dataSource });
      await service.refreshToken(RAW_REFRESH_TOKEN);

      const newTokenSave = savedEntities.find(
        (e) => e.family === 'original-family' && !e.revokedAt,
      );
      expect(newTokenSave).toBeDefined();
    });

    it('should throw 401 when token is not found in the DB', async () => {
      const { dataSource } = setupTransaction(null);
      const { service } = buildService({ dataSource });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should revoke the entire family and throw on replay (already-consumed token)', async () => {
      const revokedToken = makeRefreshToken({ revokedAt: new Date() });
      const { dataSource, rtQb } = setupTransaction(revokedToken);

      const { service } = buildService({ dataSource });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );

      expect(rtQb.update).toHaveBeenCalledWith(RefreshToken);
      expect(rtQb.execute).toHaveBeenCalled();
    });

    it('should throw 401 when the stored token is past its expiresAt', async () => {
      const expired = makeRefreshToken({
        expiresAt: new Date(Date.now() - 1000),
      });
      const { dataSource } = setupTransaction(expired);
      const { service } = buildService({ dataSource });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw 401 when the user is disabled', async () => {
      const storedToken = makeRefreshToken();
      const disabledUser = makeUser({ disabled: true });
      const { dataSource } = setupTransaction(storedToken, disabledUser);
      const { service } = buildService({ dataSource });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw 401 when the user is soft-deleted (banned)', async () => {
      const storedToken = makeRefreshToken();
      const bannedUser = makeUser({ deletedAt: new Date() });
      const { dataSource } = setupTransaction(storedToken, bannedUser);
      const { service } = buildService({ dataSource });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw 401 when the JWT signature is invalid', async () => {
      const jwtAuthService = makeMockJwtService();
      jwtAuthService.verifyRefreshToken.mockImplementation(() => {
        throw Object.assign(new Error('invalid signature'), {
          name: 'JsonWebTokenError',
        });
      });
      const { service } = buildService({ jwtAuthService });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw 401 with expiry message when the JWT is expired', async () => {
      const jwtAuthService = makeMockJwtService();
      jwtAuthService.verifyRefreshToken.mockImplementation(() => {
        throw Object.assign(new Error('jwt expired'), {
          name: 'TokenExpiredError',
        });
      });
      const { service } = buildService({ jwtAuthService });

      await expect(service.refreshToken(RAW_REFRESH_TOKEN)).rejects.toThrow(
        'expired',
      );
    });

    it('should throw 401 when called with an empty string', async () => {
      const { service } = buildService();
      await expect(service.refreshToken('')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('should revoke only the given session when a refresh token is provided', async () => {
      const { service, rtRepo } = buildService();

      await service.logout('user-uuid-1', RAW_REFRESH_TOKEN);

      expect(rtRepo.revokeByHash).toHaveBeenCalledWith(hash(RAW_REFRESH_TOKEN));
      expect(rtRepo.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('should revoke all sessions when no refresh token is provided', async () => {
      const { service, rtRepo } = buildService();

      await service.logout('user-uuid-1');

      expect(rtRepo.revokeAllForUser).toHaveBeenCalledWith('user-uuid-1');
      expect(rtRepo.revokeByHash).not.toHaveBeenCalled();
    });

    it('should return a success response in both cases', async () => {
      const { service } = buildService();

      const result = await service.logout('user-uuid-1', RAW_REFRESH_TOKEN);

      expect(result.success).toBe(true);
    });
  });

  describe('logoutAll', () => {
    it('should revoke all sessions for the user', async () => {
      const { service, rtRepo } = buildService();

      const result = await service.logoutAll('user-uuid-1');

      expect(rtRepo.revokeAllForUser).toHaveBeenCalledWith('user-uuid-1');
      expect(result.success).toBe(true);
    });
  });

  describe('changePassword', () => {
    const setupChangePassword = (userOverrides: any = {}) => {
      const user = makeUser({ password: 'old-hash', ...userOverrides });
      const userManagerRepo = {
        findOne: jest.fn().mockResolvedValue(user),
        save: jest.fn().mockResolvedValue(user),
      };
      const mockManager = {
        getRepository: jest.fn().mockReturnValue(userManagerRepo),
      };
      const passwordService = makeMockPasswordService();
      passwordService.comparePassword.mockResolvedValue(false); // new ≠ old
      const rtRepo = makeMockRtRepo();
      const dataSource = {
        transaction: jest
          .fn()
          .mockImplementation(async (cb: any) => cb(mockManager)),
      };

      return {
        user,
        userManagerRepo,
        mockManager,
        passwordService,
        rtRepo,
        dataSource,
      };
    };

    it('should revoke all refresh tokens after a successful password change', async () => {
      const { passwordService, rtRepo, dataSource, mockManager } =
        setupChangePassword();
      const { service } = buildService({ passwordService, rtRepo, dataSource });

      await service.changePassword('user-uuid-1', {
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
      } as any);

      expect(rtRepo.revokeAllForUser).toHaveBeenCalledWith(
        'user-uuid-1',
        mockManager,
      );
    });

    it('should return success after changing the password', async () => {
      const { passwordService, rtRepo, dataSource } = setupChangePassword();
      const { service } = buildService({ passwordService, rtRepo, dataSource });

      const result = await service.changePassword('user-uuid-1', {
        currentPassword: 'OldPass1!',
        newPassword: 'NewPass1!',
      } as any);

      expect(result.success).toBe(true);
    });
  });

  describe('deactivateUser', () => {
    it('should revoke all refresh tokens when deactivating a user', async () => {
      const targetUser = makeUser({ id: 'target-uuid' });
      const userRepo = makeMockUserRepo();
      userRepo.findOne.mockResolvedValue(targetUser);
      userRepo.save.mockResolvedValue(targetUser);
      const rtRepo = makeMockRtRepo();
      const auditService = makeMockAuditService();
      const notifications = makeMockNotifications();

      const { service } = buildService({
        userRepo,
        rtRepo,
        auditService,
        notifications,
      });

      await service.deactivateUser(
        'target-uuid',
        { id: 'admin-uuid', roles: ['system_admin'], permissions: [] },
        'policy violation',
      );

      expect(rtRepo.revokeAllForUser).toHaveBeenCalledWith('target-uuid');
    });

    it('should throw ForbiddenException when caller lacks permission', async () => {
      const { service } = buildService();

      await expect(
        service.deactivateUser(
          'target-uuid',
          { id: 'actor-uuid', roles: ['actor'], permissions: [] },
          'reason',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException when target user does not exist', async () => {
      const userRepo = makeMockUserRepo();
      userRepo.findOne.mockResolvedValue(null);

      const { service } = buildService({ userRepo });

      await expect(
        service.deactivateUser(
          'ghost-uuid',
          { id: 'admin-uuid', roles: ['system_admin'], permissions: [] },
          'reason',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('banUser', () => {
    it('should revoke all refresh tokens when banning a user', async () => {
      const targetUser = makeUser({ id: 'target-uuid' });
      const userRepo = makeMockUserRepo();
      userRepo.findOne.mockResolvedValue(targetUser);
      userRepo.save.mockResolvedValue(targetUser);
      const rtRepo = makeMockRtRepo();

      const { service } = buildService({
        userRepo,
        rtRepo,
        auditService: makeMockAuditService(),
        notifications: makeMockNotifications(),
      });

      await service.banUser(
        'target-uuid',
        { id: 'admin-uuid', roles: ['system_admin'], permissions: [] },
        'spam',
      );

      expect(rtRepo.revokeAllForUser).toHaveBeenCalledWith('target-uuid');
    });
  });

  describe('reactivateUser', () => {
    it('should revoke all refresh tokens when reactivating (force re-login)', async () => {
      const targetUser = makeUser({ id: 'target-uuid', disabled: true });
      const userRepo = makeMockUserRepo();
      userRepo.findOne.mockResolvedValue(targetUser);
      userRepo.save.mockResolvedValue(targetUser);
      const rtRepo = makeMockRtRepo();

      const { service } = buildService({
        userRepo,
        rtRepo,
        auditService: makeMockAuditService(),
        notifications: makeMockNotifications(),
      });

      await service.reactivateUser(
        'target-uuid',
        { id: 'admin-uuid', roles: ['system_admin'], permissions: [] },
        'appeal approved',
      );

      expect(rtRepo.revokeAllForUser).toHaveBeenCalledWith('target-uuid');
    });
  });
});
