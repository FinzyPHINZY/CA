/** biome-ignore-all lint/suspicious/noExplicitAny: test file */
import { RefreshTokenRepository } from './refresh-token.repository';
import { RefreshToken } from '../entities/refresh-token.entity';

const makeToken = (overrides: Partial<RefreshToken> = {}): RefreshToken =>
  ({
    id: 'rt-uuid-1',
    userId: 'user-uuid-1',
    tokenHash: 'abc123hash',
    family: 'family-uuid-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: undefined,
    ...overrides,
  }) as RefreshToken;

describe('RefreshTokenRepository', () => {
  let repository: RefreshTokenRepository;
  let mockQueryBuilder: any;

  beforeEach(() => {
    mockQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      getOne: jest.fn().mockResolvedValue(null),
    };

    repository = Object.create(
      RefreshTokenRepository.prototype,
    ) as RefreshTokenRepository;
    jest
      .spyOn(repository, 'createQueryBuilder')
      .mockReturnValue(mockQueryBuilder as any);
    jest.spyOn(repository, 'findOne').mockResolvedValue(null);
  });

  afterEach(() => jest.clearAllMocks());

  describe('findActiveByHash', () => {
    it('should query by hash, excluding revoked and expired', async () => {
      const token = makeToken();
      mockQueryBuilder.getOne.mockResolvedValue(token);

      const result = await repository.findActiveByHash('abc123hash');

      expect(result).toEqual(token);
      expect(repository.createQueryBuilder).toHaveBeenCalledWith('rt');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'rt.tokenHash = :tokenHash',
        { tokenHash: 'abc123hash' },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'rt.revokedAt IS NULL',
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'rt.expiresAt > NOW()',
      );
    });

    it('should return null when no active token matches', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);
      const result = await repository.findActiveByHash('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('findAnyByHash', () => {
    it('should find a token regardless of revoked status', async () => {
      const revoked = makeToken({ revokedAt: new Date() });
      (repository.findOne as jest.Mock).mockResolvedValue(revoked);

      const result = await repository.findAnyByHash('abc123hash');

      expect(result).toEqual(revoked);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { tokenHash: 'abc123hash' },
      });
    });

    it('should return null when hash has never been seen', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);
      const result = await repository.findAnyByHash('unknown');
      expect(result).toBeNull();
    });
  });

  describe('revokeByHash', () => {
    it('should revoke only the token matching the hash', async () => {
      await repository.revokeByHash('abc123hash');

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(RefreshToken);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        revokedAt: expect.any(Date),
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'tokenHash = :tokenHash AND revokedAt IS NULL',
        { tokenHash: 'abc123hash' },
      );
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it('should use the provided EntityManager when given', async () => {
      const managerQb = { ...mockQueryBuilder };
      const mockManager = {
        createQueryBuilder: jest.fn().mockReturnValue(managerQb),
      };

      await repository.revokeByHash('abc123hash', mockManager as any);

      expect(mockManager.createQueryBuilder).toHaveBeenCalled();
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllByFamily', () => {
    it('should revoke all active tokens in the family', async () => {
      await repository.revokeAllByFamily('family-uuid-1');

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(RefreshToken);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        revokedAt: expect.any(Date),
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'family = :family AND revokedAt IS NULL',
        { family: 'family-uuid-1' },
      );
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it('should use the provided EntityManager when given', async () => {
      const managerQb = { ...mockQueryBuilder };
      const mockManager = {
        createQueryBuilder: jest.fn().mockReturnValue(managerQb),
      };

      await repository.revokeAllByFamily('family-uuid-1', mockManager as any);

      expect(mockManager.createQueryBuilder).toHaveBeenCalled();
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllForUser', () => {
    it('should revoke all active tokens for the user', async () => {
      await repository.revokeAllForUser('user-uuid-1');

      expect(mockQueryBuilder.update).toHaveBeenCalledWith(RefreshToken);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        revokedAt: expect.any(Date),
      });
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'userId = :userId AND revokedAt IS NULL',
        { userId: 'user-uuid-1' },
      );
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it('should use the provided EntityManager when given', async () => {
      const managerQb = { ...mockQueryBuilder };
      const mockManager = {
        createQueryBuilder: jest.fn().mockReturnValue(managerQb),
      };

      await repository.revokeAllForUser('user-uuid-1', mockManager as any);

      expect(mockManager.createQueryBuilder).toHaveBeenCalled();
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
