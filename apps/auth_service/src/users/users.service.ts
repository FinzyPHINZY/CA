/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */
import {
  BaseResponseDto,
  DOMAIN_EVENTS_SERVICE,
  EVENT_PATTERNS,
  Genre,
  RefreshToken,
  User,
  type UserDeletedEvent,
} from '@app/common';
import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, EntityManager } from 'typeorm';
import { UpdateSelfDto } from './dto/update-self.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(DOMAIN_EVENTS_SERVICE)
    private readonly domainEventsClient: ClientProxy,
  ) {}

  /**
   * Get authenticated user's profile information
   */
  async getSelf(userId: string) {
    if (!userId) {
      throw new UnauthorizedException('User ID is required');
    }

    const userRepo = this.dataSource.getRepository(User);

    const user = await userRepo.findOne({
      where: { id: userId },
      relations: { genres: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      success: true,
      message: 'User profile retrieved successfully',
      data: this.buildUserResponse(user),
    };
  }

  /**
   * Update authenticated user's profile information
   */
  async updateSelf(userId: string, dto: UpdateSelfDto) {
    const updatedUser = await this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const genreRepo = manager.getRepository(Genre);

      const user = await this.findUserWithGenres(userRepo, userId);
      if (!user) {
        throw new NotFoundException('User not found');
      }

      this.updateUserFields(user, dto);

      if (dto.genres) {
        user.genres = await this.processGenres(genreRepo, dto.genres);
      }

      const saved = await userRepo.save(user);
      return this.buildUserResponse(saved);
    });

    // Emit user.updated event so other services can react (e.g. regenerate slots on timezone change)
    const updatedFields: Array<
      'email' | 'fullName' | 'avatar' | 'roles' | 'timezone'
    > = [];
    if (dto.fullName !== undefined) updatedFields.push('fullName');
    if (dto.avatar !== undefined) updatedFields.push('avatar');
    if (dto.timezone !== undefined) updatedFields.push('timezone');

    if (updatedFields.length > 0) {
      this.domainEventsClient
        .emit(EVENT_PATTERNS.USER_UPDATED, {
          userId,
          updatedFields,
          updatedAt: new Date().toISOString(),
        })
        .subscribe();
    }

    return {
      success: true,
      message: 'User profile updated successfully',
      data: updatedUser,
    };
  }

  /**
   * Destroy (soft delete) the authenticated user's account
   * Sets deletedAt timestamp, disables the account, and clears refresh token
   * Publishes user.deleted event for cross-service cleanup
   */
  async destroySelf(userId: string): Promise<BaseResponseDto> {
    let userEmail: string | undefined;

    await this.dataSource.transaction(async (manager: EntityManager) => {
      const userRepo = manager.getRepository(User);

      const user = await userRepo.findOne({
        where: { id: userId },
        withDeleted: true,
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      userEmail = user.email;

      // Soft delete the user (sets deletedAt)
      await userRepo.softRemove(user);

      // Disable the account and revoke all refresh tokens
      user.disabled = true;
      await userRepo.save(user);
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('userId = :userId AND revokedAt IS NULL', { userId })
        .execute();
    });

    // publish user.deleted event for cross-service cleanup
    // this is done outside the transaction to ensure the DB commit succeeded first
    if (userEmail) {
      const event: Omit<UserDeletedEvent, 'pattern'> = {
        userId,
        email: userEmail,
        deletedAt: new Date().toISOString(),
        isSoftDelete: true,
      };

      this.domainEventsClient.emit(EVENT_PATTERNS.USER_DELETED, event);
      console.log(`Published user.deleted event for user ${userId}`);
    }

    return {
      success: true,
      message: 'User account deleted successfully',
    };
  }

  /**
   * Find user with genres relation
   */
  private async findUserWithGenres(
    userRepo: any,
    userId: string,
  ): Promise<User | null> {
    return userRepo.findOne({
      where: { id: userId },
      relations: { genres: true },
    });
  }

  /**
   * Update user fields from DTO
   */
  private updateUserFields(user: User, dto: UpdateSelfDto): void {
    if (dto.fullName !== undefined) {
      user.fullName = dto.fullName || null;
    }
    if (dto.phoneNumber !== undefined) {
      user.phoneNumber = dto.phoneNumber || null;
    }
    if (dto.avatar !== undefined) {
      user.avatar = dto.avatar || null;
    }
    if (dto.bio !== undefined) {
      user.bio = dto.bio || null;
    }
    if (dto.yearsOfExperience !== undefined) {
      user.yearsOfExperience = dto.yearsOfExperience || null;
    }
    if (dto.location !== undefined) {
      user.location = dto.location || null;
    }
    if (dto.timezone !== undefined) {
      user.timezone = dto.timezone || 'UTC';
    }
  }

  /**
   * Process and sync user genres
   */
  private async processGenres(
    genreRepo: any,
    genreNames: string[],
  ): Promise<Genre[]> {
    const uniqueNames = this.sanitizeGenreNames(genreNames);
    const existing = await this.findExistingGenres(genreRepo, uniqueNames);
    const newGenres = await this.createMissingGenres(
      genreRepo,
      uniqueNames,
      existing,
    );

    return [...existing, ...newGenres];
  }

  /**
   * Sanitize and deduplicate genre names
   */
  private sanitizeGenreNames(genreNames: string[]): string[] {
    return Array.from(
      new Set(genreNames.map((name) => name.trim()).filter(Boolean)),
    );
  }

  /**
   * Find existing genres by name (case-insensitive)
   */
  private async findExistingGenres(
    genreRepo: any,
    names: string[],
  ): Promise<Genre[]> {
    return genreRepo
      .createQueryBuilder('g')
      .where('LOWER(g.name) IN (:...names)', {
        names: names.map((n) => n.toLowerCase()),
      })
      .getMany();
  }

  /**
   * Create genres that don't exist yet
   */
  private async createMissingGenres(
    genreRepo: any,
    allNames: string[],
    existing: Genre[],
  ): Promise<Genre[]> {
    const existingNames = new Set(existing.map((g) => g.name.toLowerCase()));
    const toCreate = allNames.filter(
      (name) => !existingNames.has(name.toLowerCase()),
    );

    if (toCreate.length === 0) {
      return [];
    }

    const newEntities = toCreate.map((name) => genreRepo.create({ name }));
    return genreRepo.save(newEntities);
  }

  /**
   * Build user response object
   */
  private buildUserResponse(user: User) {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      roles: user.roles,
      avatar: user.avatar,
      bio: user.bio,
      yearsOfExperience: user.yearsOfExperience,
      timezone: user.timezone,
      genres: (user.genres || []).map((g) => g.name),
      emailVerified: user.emailVerified,
      deactivationReason: user.deactivationReason ?? null,
      deactivatedAt: user.deactivatedAt ?? null,
      reactivationReason: user.reactivationReason ?? null,
      reactivatedAt: user.reactivatedAt ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
