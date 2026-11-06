/** biome-ignore-all lint/style/useImportType: <> */

import {
  Availability,
  Booking,
  BookingStatus,
  FavoriteReader,
  OnboardingStatus,
  ReaderProfile,
  ReaderReview,
  RedisLockService,
  TimeSlot,
  User,
} from '@app/common';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { ReaderSortField, SearchReadersDto } from './dto/search-readers.dto';

const ONLINE_KEY_PREFIX = 'reader:online:';
const ONLINE_TTL_SECONDS = 60;

@Injectable()
export class ReaderDiscoveryService {
  private readonly logger = new Logger(ReaderDiscoveryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisLockService: RedisLockService,
  ) {}

  // search for readers with filters, pagination, and ranking and uses QueryBuilder for complex joins and filtering.
  async searchReaders(query: SearchReadersDto, actorUserId?: string) {
    const {
      genre,
      search,
      minRate,
      maxRate,
      minRating,
      isOnline,
      inSession,
      page = 1,
      limit = 20,
      sortBy = ReaderSortField.RELEVANCE,
      sortOrder = 'DESC',
    } = query;

    const qb = this.dataSource
      .getRepository(ReaderProfile)
      .createQueryBuilder('profile')
      .leftJoinAndSelect('profile.specialties', 'specialty')
      .leftJoinAndSelect('profile.sessionRates', 'rate')
      .leftJoin(User, 'user', 'user.id = profile.userId')
      .where('profile.onboardingStatus = :status', {
        status: OnboardingStatus.COMPLETED,
      })
      .andWhere('profile.isAcceptingBookings = :accepting', {
        accepting: true,
      });

    // filter by genre
    if (genre) {
      qb.andWhere('specialty.genre ILIKE :genre', { genre: `%${genre}%` });
    }

    // filter by name, headline, or bio
    if (search) {
      qb.andWhere(
        '(user.fullName ILIKE :search OR profile.headline ILIKE :search OR profile.bio ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // filter by rate range (check if any session rate falls in range)
    if (minRate !== undefined) {
      qb.andWhere('rate.priceCents >= :minRate', { minRate });
    }
    if (maxRate !== undefined) {
      qb.andWhere('rate.priceCents <= :maxRate', { maxRate });
    }

    // filter by minimum rating
    if (minRating !== undefined) {
      qb.andWhere('profile.avgRating >= :minRating', { minRating });
    }

    // filter by in-session status (DB-level subquery for accurate pagination)
    if (inSession === false) {
      qb.andWhere(
        `NOT EXISTS (
          SELECT 1 FROM marketplace_schema.bookings b
          WHERE b."readerUserId" = profile."userId"
          AND b."status" IN (:...activeStatuses)
        )`,
        {
          activeStatuses: [
            BookingStatus.IN_PROGRESS,
            BookingStatus.PENDING_ACCEPTANCE,
          ],
        },
      );
    } else if (inSession === true) {
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM marketplace_schema.bookings b
          WHERE b."readerUserId" = profile."userId"
          AND b."status" IN (:...activeStatuses)
        )`,
        {
          activeStatuses: [
            BookingStatus.IN_PROGRESS,
            BookingStatus.PENDING_ACCEPTANCE,
          ],
        },
      );
    }

    // sorting
    switch (sortBy) {
      case ReaderSortField.RATING:
        qb.orderBy('profile.avgRating', sortOrder);
        break;
      case ReaderSortField.PRICE:
        // Sort by lowest session rate
        qb.addSelect(
          '(SELECT MIN(r."priceCents") FROM marketplace_schema.reader_session_rates r WHERE r."readerProfileId" = profile.id)',
          'min_price',
        );
        qb.orderBy('min_price', sortOrder === 'DESC' ? 'DESC' : 'ASC');
        break;
      case ReaderSortField.SESSIONS:
        qb.orderBy('profile.totalSessions', sortOrder);
        break;
      // case ReaderSortField.RELEVANCE:
      default:
        // composite relevance: online > rating > sessions > response time
        qb.orderBy('profile.avgRating', 'DESC');
        qb.addOrderBy('profile.totalSessions', 'DESC');
        break;
    }

    // always add a secondary sort for deterministic pagination
    qb.addOrderBy('profile.createdAt', 'DESC');

    // pagination
    const offset = (page - 1) * limit;
    qb.skip(offset).take(limit);

    const [profiles, total] = await qb.getManyAndCount();

    // enrich with user info (name, avatar)
    const profilesWithUser = await this.enrichWithUserInfo(profiles);

    // enrich with online status from Redis and session status from DB
    const withOnlineStatus =
      await this.enrichWithOnlineStatus(profilesWithUser);
    const enrichedProfiles =
      await this.enrichWithSessionStatus(withOnlineStatus);

    // if isOnline filter is set, filter after Redis check
    let results = enrichedProfiles;
    let filteredTotal = total;
    if (isOnline === true) {
      results = enrichedProfiles.filter((p) => p.isOnlineNow);
      filteredTotal = results.length;
    }

    // if actor is authenticated, mark favorited readers
    if (actorUserId) {
      const favoriteRepo = this.dataSource.getRepository(FavoriteReader);
      const favorites = await favoriteRepo.find({
        where: { userId: actorUserId },
      });
      const favoriteProfileIds = new Set(
        favorites.map((f) => f.readerProfileId),
      );
      results = results.map((r) => ({
        ...r,
        isFavorited: favoriteProfileIds.has(r.id),
      }));
    }

    const totalPages = Math.ceil(filteredTotal / limit);

    // shape results to lightweight card format
    const cards = results.map((r) => this.toReaderCard(r));

    return {
      success: true,
      message: 'Readers retrieved successfully',
      data: {
        items: cards,
        total: filteredTotal,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // get a public reader profile by profile ID and includes rates, specialties, work samples, social links, and recent reviews.
  async getPublicProfile(profileId: string) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { id: profileId, onboardingStatus: OnboardingStatus.COMPLETED },
      relations: [
        'sessionRates',
        'specialties',
        'workSamples',
        'socialLinks',
        'reviews',
      ],
    });

    if (!profile) {
      throw new NotFoundException('Reader profile not found');
    }

    // get online status and session status
    const isOnlineNow = await this.isReaderOnline(profile.userId);
    const [withSessionStatus] = await this.enrichWithSessionStatus([profile]);

    // get user info (name, avatar)
    const [enrichedProfile] = await this.enrichWithUserInfo([profile]);

    // get recent reviews with limit
    const reviewRepo = this.dataSource.getRepository(ReaderReview);
    const recentReviews = await reviewRepo.find({
      where: { readerProfileId: profileId },
      order: { createdAt: 'DESC' },
      take: 10,
    });

    // get weekly availability schedule from template slots (date IS NULL)
    const availabilityRepo = this.dataSource.getRepository(Availability);
    const availability = await availabilityRepo.findOne({
      where: { userId: profile.userId },
      relations: ['timeSlots'],
    });

    const availableSchedule = this.buildAvailableSchedule(
      availability?.timeSlots ?? [],
    );

    return {
      success: true,
      message: 'Reader profile retrieved successfully',
      data: {
        ...enrichedProfile,
        workSamples: (enrichedProfile.workSamples ?? []).map((sample: any) =>
          this.toPublicWorkSample(sample),
        ),
        reviews: recentReviews,
        isOnlineNow,
        inSession: withSessionStatus.inSession,
        availableSchedule,
      },
    };
  }

  private buildAvailableSchedule(
    timeSlots: TimeSlot[],
  ): { day: string; slots: { start: string; end: string }[] }[] {
    const templateSlots = timeSlots.filter((slot) => !slot.date);

    const grouped = new Map<string, { start: string; end: string }[]>();

    for (const slot of templateSlots) {
      if (!grouped.has(slot.dayOfWeek)) {
        grouped.set(slot.dayOfWeek, []);
      }
      grouped.get(slot.dayOfWeek)!.push({
        start: slot.startTime,
        end: slot.endTime,
      });
    }

    const dayOrder = [
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ];

    return dayOrder
      .filter((day) => grouped.has(day))
      .map((day) => ({ day, slots: grouped.get(day)! }));
  }

  // record a heartbeat to mark a reader as online and sets a Redis key with TTL for presence tracking.
  async heartbeat(userId: string) {
    const key = `${ONLINE_KEY_PREFIX}${userId}`;
    await this.redisLockService.setWithTTL(key, '1', ONLINE_TTL_SECONDS);
    return {
      success: true,
      message: 'Heartbeat recorded successfully',
    };
  }

  // explicitly mark a reader as offline by deleting the Redis presence key.
  async goOffline(userId: string) {
    const key = `${ONLINE_KEY_PREFIX}${userId}`;
    await this.redisLockService.del(key);
    return {
      success: true,
      message: 'Reader is now offline',
    };
  }

  // check if a specific reader is online.
  async isReaderOnline(userId: string): Promise<boolean> {
    const key = `${ONLINE_KEY_PREFIX}${userId}`;
    return this.redisLockService.exists(key);
  }

  // add a reader to actor's favorites.
  async addFavorite(userId: string, readerProfileId: string) {
    const favoriteRepo = this.dataSource.getRepository(FavoriteReader);

    // verify reader profile exists
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { id: readerProfileId },
    });
    if (!profile) {
      throw new NotFoundException('Reader profile not found');
    }

    // don't allow favoriting yourself
    if (profile.userId === userId) {
      throw new ConflictException('Cannot favorite your own profile');
    }

    // check if already favorited
    const existing = await favoriteRepo.findOne({
      where: { userId, readerProfileId },
    });
    if (existing) {
      throw new ConflictException('Reader already in favorites');
    }

    const favorite = favoriteRepo.create({ userId, readerProfileId });
    const saved = await favoriteRepo.save(favorite);
    return {
      success: true,
      message: 'Reader added to favorites',
      data: saved,
    };
  }

  // remove a reader from actor's favorites.
  async removeFavorite(userId: string, readerProfileId: string) {
    const favoriteRepo = this.dataSource.getRepository(FavoriteReader);
    const favorite = await favoriteRepo.findOne({
      where: { userId, readerProfileId },
    });

    if (!favorite) {
      throw new NotFoundException('Favorite not found');
    }

    await favoriteRepo.remove(favorite);
    return {
      success: true,
      message: 'Reader removed from favorites',
    };
  }

  // list favorited readers for an actor (paginated, includes online status).
  async listFavorites(userId: string, page: number = 1, limit: number = 20) {
    const favoriteRepo = this.dataSource.getRepository(FavoriteReader);
    const offset = (page - 1) * limit;

    const [favorites, total] = await favoriteRepo.findAndCount({
      where: { userId },
      skip: offset,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    if (favorites.length === 0) {
      return {
        success: true,
        message: 'Favorites retrieved successfully',
        data: {
          items: [],
          total: 0,
          page,
          limit,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
    }

    // load full profiles for favorited readers
    const profileIds = favorites.map((f) => f.readerProfileId);
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profiles = await profileRepo
      .createQueryBuilder('profile')
      .leftJoinAndSelect('profile.specialties', 'specialty')
      .leftJoinAndSelect('profile.sessionRates', 'rate')
      .where('profile.id IN (:...ids)', { ids: profileIds })
      .getMany();

    // enrich with user info, online status, and session status
    const withUserInfo = await this.enrichWithUserInfo(profiles);
    const withOnline = await this.enrichWithOnlineStatus(withUserInfo);
    const enriched = await this.enrichWithSessionStatus(withOnline);
    const enrichedMap = new Map(enriched.map((p) => [p.id, p]));

    // maintain favorites order and shape to card format
    const data = favorites
      .map((f) => {
        const profile = enrichedMap.get(f.readerProfileId);
        if (!profile) return null;
        return {
          ...this.toReaderCard({ ...profile, isFavorited: true }),
          favoritedAt: f.createdAt,
        };
      })
      .filter(Boolean);

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Favorites retrieved successfully',
      data: {
        items: data,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // enrich an array of reader profiles with in-session status from the bookings table.
  private async enrichWithSessionStatus<T extends { userId: string }>(
    profiles: T[],
  ): Promise<(T & { inSession: boolean })[]> {
    if (profiles.length === 0) return [];

    const userIds = profiles.map((p) => p.userId);
    const bookingRepo = this.dataSource.getRepository(Booking);

    const busyBookings = await bookingRepo
      .createQueryBuilder('b')
      .select('DISTINCT b."readerUserId"', 'readerUserId')
      .where('b."readerUserId" IN (:...userIds)', { userIds })
      .andWhere('b."status" IN (:...activeStatuses)', {
        activeStatuses: [
          BookingStatus.IN_PROGRESS,
          BookingStatus.PENDING_ACCEPTANCE,
        ],
      })
      .getRawMany();

    const busyUserIds = new Set(busyBookings.map((r) => r.readerUserId));

    return profiles.map((profile) => ({
      ...profile,
      inSession: busyUserIds.has(profile.userId),
    }));
  }

  // enrich an array of reader profiles with real-time online status from Redis.
  private async enrichWithOnlineStatus(
    profiles: ReaderProfile[],
  ): Promise<(ReaderProfile & { isOnlineNow: boolean })[]> {
    if (profiles.length === 0) return [];

    const onlineChecks = await Promise.all(
      profiles.map((p) => this.isReaderOnline(p.userId)),
    );

    return profiles.map((profile, i) => ({
      ...profile,
      isOnlineNow: onlineChecks[i],
    }));
  }

  // enrich an array of reader profiles with user info (fullName, avatar) from the User table.
  private async enrichWithUserInfo(profiles: ReaderProfile[]): Promise<
    (ReaderProfile & {
      readerName: string | null;
      readerAvatar: string | null;
    })[]
  > {
    if (profiles.length === 0) return [];

    const userIds = profiles.map((p) => p.userId);
    const userRepo = this.dataSource.getRepository(User);
    const users = await userRepo.find({
      where: { id: In(userIds) },
      select: ['id', 'fullName', 'avatar'],
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    return profiles.map((profile) => {
      const user = userMap.get(profile.userId);
      return {
        ...profile,
        readerName: user?.fullName ?? null,
        readerAvatar: user?.avatar ?? null,
      };
    });
  }

  // shape an enriched reader profile to a lightweight card for search/listing responses.
  private toReaderCard(profile: any) {
    const lowestRate = profile.sessionRates?.length
      ? profile.sessionRates.reduce(
          (min: any, r: any) => (r.priceCents < min.priceCents ? r : min),
          profile.sessionRates[0],
        )
      : null;

    return {
      id: profile.id,
      readerName: profile.readerName ?? null,
      readerAvatar: profile.readerAvatar ?? null,
      headline: profile.headline ?? null,
      avgRating: profile.avgRating,
      totalReviews: profile.totalReviews,
      totalSessions: profile.totalSessions,
      genres: profile.specialties?.map((s: any) => s.genre) ?? [],
      startingPriceCents: lowestRate?.priceCents ?? null,
      currency: lowestRate?.currency ?? null,
      isOnlineNow: profile.isOnlineNow ?? false,
      inSession: profile.inSession ?? false,
      ...(profile.isFavorited !== undefined && {
        isFavorited: profile.isFavorited,
      }),
    };
  }

  private toPublicWorkSample(sample: any) {
    return {
      id: sample.id,
      title: sample.title,
      url: sample.url,
      thumbnailUrl: sample.thumbnailUrl ?? null,
      type: sample.type,
      sourceType: sample.sourceType,
      createdAt: sample.createdAt,
      updatedAt: sample.updatedAt,
    };
  }
}
