/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/style/noNonNullAssertion: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Availability,
  Booking,
  FavoriteReader,
  OnboardingStatus,
  ReaderProfile,
  ReaderReview,
  RedisLockService,
  User,
} from '@app/common';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReaderSortField, SortOrder } from './dto/search-readers.dto';
import { ReaderDiscoveryService } from './reader-discovery.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    remove: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

function mockQueryBuilder(result: any[] = [], count: number = 0) {
  return {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(result),
    getManyAndCount: jest.fn().mockResolvedValue([result, count]),
    getRawMany: jest.fn().mockResolvedValue(result),
  };
}

describe('ReaderDiscoveryService', () => {
  let service: ReaderDiscoveryService;

  let profileRepo: ReturnType<typeof mockRepository>;
  let favoriteRepo: ReturnType<typeof mockRepository>;
  let reviewRepo: ReturnType<typeof mockRepository>;
  let userRepo: ReturnType<typeof mockRepository>;
  let bookingRepo: ReturnType<typeof mockRepository>;
  let availabilityRepo: ReturnType<typeof mockRepository>;
  let mockRedisLockService: jest.Mocked<Partial<RedisLockService>>;

  const actorUserId = 'actor-1';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    profileRepo = mockRepository();
    favoriteRepo = mockRepository();
    reviewRepo = mockRepository();
    userRepo = mockRepository();
    bookingRepo = mockRepository();
    availabilityRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[FavoriteReader.name] = favoriteRepo;
    repoMap[ReaderReview.name] = reviewRepo;
    repoMap[User.name] = userRepo;
    repoMap[Booking.name] = bookingRepo;
    repoMap[Availability.name] = availabilityRepo;

    mockRedisLockService = {
      setWithTTL: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<Partial<RedisLockService>>;

    const mockDataSource = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    // Default: no readers in session
    bookingRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

    service = new ReaderDiscoveryService(
      mockDataSource,
      mockRedisLockService as unknown as RedisLockService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── searchReaders ────────────────────────────────────────────────

  describe('searchReaders', () => {
    it('should return paginated search results', async () => {
      const profiles = [
        {
          id: 'p1',
          userId: 'u1',
          avgRating: 4.5,
          specialties: [],
          sessionRates: [],
        },
        {
          id: 'p2',
          userId: 'u2',
          avgRating: 4.0,
          specialties: [],
          sessionRates: [],
        },
      ];
      const qb = mockQueryBuilder(profiles, 2);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([
        { id: 'u1', fullName: 'User One', avatar: null },
        { id: 'u2', fullName: 'User Two', avatar: null },
      ]);

      const result = await service.searchReaders({});

      expect(result.data.items).toHaveLength(2);
      expect(result.data.total).toBe(2);
      expect(result.data.page).toBe(1);
      expect(result.data.items[0].readerName).toBe('User One');
    });

    it('should filter by genre', async () => {
      const qb = mockQueryBuilder([], 0);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([]);

      await service.searchReaders({ genre: 'Drama' });

      expect(qb.andWhere).toHaveBeenCalledWith('specialty.genre ILIKE :genre', {
        genre: '%Drama%',
      });
    });

    it('should filter by search text', async () => {
      const qb = mockQueryBuilder([], 0);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([]);

      await service.searchReaders({ search: 'shakespeare' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        '(user.fullName ILIKE :search OR profile.headline ILIKE :search OR profile.bio ILIKE :search)',
        { search: '%shakespeare%' },
      );
    });

    it('should filter by rate range', async () => {
      const qb = mockQueryBuilder([], 0);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([]);

      await service.searchReaders({ minRate: 1000, maxRate: 5000 });

      expect(qb.andWhere).toHaveBeenCalledWith('rate.priceCents >= :minRate', {
        minRate: 1000,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('rate.priceCents <= :maxRate', {
        maxRate: 5000,
      });
    });

    it('should filter by minimum rating', async () => {
      const qb = mockQueryBuilder([], 0);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([]);

      await service.searchReaders({ minRating: 4.0 });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'profile.avgRating >= :minRating',
        { minRating: 4.0 },
      );
    });

    it('should sort by rating', async () => {
      const qb = mockQueryBuilder([], 0);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([]);

      await service.searchReaders({
        sortBy: ReaderSortField.RATING,
        sortOrder: SortOrder.DESC,
      });

      expect(qb.orderBy).toHaveBeenCalledWith('profile.avgRating', 'DESC');
    });

    it('should mark favorited readers for authenticated actor', async () => {
      const profiles = [
        { id: 'p1', userId: 'u1', specialties: [], sessionRates: [] },
        { id: 'p2', userId: 'u2', specialties: [], sessionRates: [] },
      ];
      const qb = mockQueryBuilder(profiles, 2);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      favoriteRepo.find.mockResolvedValue([{ readerProfileId: 'p1' }]);
      userRepo.find.mockResolvedValue([
        { id: 'u1', fullName: 'User One', avatar: null },
        { id: 'u2', fullName: 'User Two', avatar: null },
      ]);

      const result = await service.searchReaders({}, actorUserId);

      const favoritedIds = result.data.items
        .filter((d: any) => d.isFavorited)
        .map((d: any) => d.id);
      expect(favoritedIds).toContain('p1');
    });

    it('should return pagination metadata', async () => {
      const qb = mockQueryBuilder(
        [{ id: 'p1', userId: 'u1', specialties: [], sessionRates: [] }],
        50,
      );
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([
        { id: 'u1', fullName: 'User One', avatar: null },
      ]);

      const result = await service.searchReaders({ page: 2, limit: 10 });

      expect(result.data.total).toBe(50);
      expect(result.data.totalPages).toBe(5);
      expect(result.data.hasNext).toBe(true);
      expect(result.data.hasPrev).toBe(true);
    });
  });

  // ─── getPublicProfile ─────────────────────────────────────────────

  describe('getPublicProfile', () => {
    it('should return profile with reviews and online status', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'p1',
        userId: 'u1',
        onboardingStatus: OnboardingStatus.COMPLETED,
      });
      reviewRepo.find.mockResolvedValue([{ id: 'r1', rating: 5 }]);
      userRepo.find.mockResolvedValue([
        { id: 'u1', fullName: 'User One', avatar: null },
      ]);

      const result = await service.getPublicProfile('p1');

      expect(result.data.id).toBe('p1');
      expect(result.data.reviews).toHaveLength(1);
      expect(result.data.isOnlineNow).toBe(false);
    });

    it('should throw if profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.getPublicProfile('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── heartbeat & isReaderOnline ───────────────────────────────────

  describe('heartbeat', () => {
    it('should set Redis key with TTL', async () => {
      await service.heartbeat('user-1');

      expect(mockRedisLockService.setWithTTL).toHaveBeenCalledWith(
        'reader:online:user-1',
        '1',
        60,
      );
    });
  });

  describe('isReaderOnline', () => {
    it('should return true when Redis key exists', async () => {
      mockRedisLockService.exists!.mockResolvedValue(true);

      const result = await service.isReaderOnline('user-1');

      expect(result).toBe(true);
    });

    it('should return false when Redis key does not exist', async () => {
      mockRedisLockService.exists!.mockResolvedValue(false);

      const result = await service.isReaderOnline('user-1');

      expect(result).toBe(false);
    });
  });

  // ─── addFavorite ──────────────────────────────────────────────────

  describe('addFavorite', () => {
    it('should add a favorite', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'p1',
        userId: 'reader-1',
      });
      favoriteRepo.findOne.mockResolvedValue(null);

      const result = await service.addFavorite(actorUserId, 'p1');

      expect(result.data.userId).toBe(actorUserId);
      expect(result.data.readerProfileId).toBe('p1');
    });

    it('should throw if profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      await expect(
        service.addFavorite(actorUserId, 'nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw if favoriting own profile', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'p1',
        userId: actorUserId,
      });

      await expect(service.addFavorite(actorUserId, 'p1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw if already favorited', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'p1',
        userId: 'reader-1',
      });
      favoriteRepo.findOne.mockResolvedValue({ id: 'existing-fav' });

      await expect(service.addFavorite(actorUserId, 'p1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // ─── removeFavorite ───────────────────────────────────────────────

  describe('removeFavorite', () => {
    it('should remove a favorite', async () => {
      favoriteRepo.findOne.mockResolvedValue({ id: 'fav-1' });

      await service.removeFavorite(actorUserId, 'p1');

      expect(favoriteRepo.remove).toHaveBeenCalled();
    });

    it('should throw if favorite not found', async () => {
      favoriteRepo.findOne.mockResolvedValue(null);

      await expect(service.removeFavorite(actorUserId, 'p1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── listFavorites ────────────────────────────────────────────────

  describe('listFavorites', () => {
    it('should return empty result when no favorites', async () => {
      favoriteRepo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.listFavorites(actorUserId);

      expect(result.data.items).toEqual([]);
      expect(result.data.total).toBe(0);
    });

    it('should return enriched favorites with pagination', async () => {
      const favorites = [{ readerProfileId: 'p1', createdAt: new Date() }];
      favoriteRepo.findAndCount.mockResolvedValue([favorites, 1]);

      const qb = mockQueryBuilder([
        { id: 'p1', userId: 'u1', specialties: [], sessionRates: [] },
      ]);
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      userRepo.find.mockResolvedValue([
        { id: 'u1', fullName: 'User One', avatar: null },
      ]);

      const result = await service.listFavorites(actorUserId, 1, 10);

      expect(result.data.items).toHaveLength(1);
      expect(result.data.total).toBe(1);
      expect(result.data.totalPages).toBe(1);
    });
  });
});
