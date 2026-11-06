import { AUTH_SERVICE } from '@app/common';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, firstValueFrom, of, timeout } from 'rxjs';
import {
  DISPLAY_DEFAULTS,
  DisplayPreferences,
  SESSION_DEFAULTS,
  SessionSettings,
} from '../interfaces/rehearsal-settings.interface';

export interface UserRehearsalPreferences {
  display: DisplayPreferences;
  sessionDefaults: SessionSettings;
}

// user DTO returned from auth service
// contains only non-sensitive user data needed for display purposes
export interface UserDto {
  id: string;
  email: string;
  fullName: string | null;
  avatar: string | null;
  roles: string[];
  timezone: string;
}

/**
 * Auth Client Service for cross-service user data fetching.
 *
 * This service provides a clean API for fetching user data from the auth service.
 * Use this instead of database JOINs to maintain schema isolation.
 *
 * @example
 * // get user for a recording
 * const user = await this.authClient.getUserById(recording.userId);
 *
 * // get users for multiple recordings
 * const userIds = recordings.map(r => r.userId);
 * const users = await this.authClient.getUsersByIds(userIds);
 */
@Injectable()
export class AuthClientService implements OnModuleInit {
  constructor(
    @Inject(AUTH_SERVICE) private readonly authServiceClient: ClientProxy,
  ) {}

  async onModuleInit() {
    // connect to the auth service on module init
    await this.authServiceClient.connect();
  }

  // get a single user by ID
  // returns null if user not found or auth service unavailable
  async getUserById(userId: string): Promise<UserDto | null> {
    if (!userId) {
      return null;
    }

    try {
      const result = await firstValueFrom(
        this.authServiceClient.send<UserDto | null>('getUserById', userId).pipe(
          timeout(5000), // 5 second timeout
          catchError((error) => {
            console.warn(`Failed to fetch user ${userId}:`, error.message);
            return of(null);
          }),
        ),
      );
      return result;
    } catch (error) {
      console.warn(`Error fetching user ${userId}:`, error);
      return null;
    }
  }

  // get multiple users by IDs (batch operation)
  // more efficient than calling getUserById multiple times
  // returns a Map for easy lookup by ID
  async getUsersByIds(userIds: string[]): Promise<Map<string, UserDto>> {
    if (!userIds || userIds.length === 0) {
      return new Map();
    }

    // Deduplicate IDs
    const uniqueIds = [...new Set(userIds.filter(Boolean))];

    try {
      const users = await firstValueFrom(
        this.authServiceClient.send<UserDto[]>('getUsersByIds', uniqueIds).pipe(
          timeout(10000), // 10 second timeout for batch
          catchError((error) => {
            console.warn('Failed to fetch users batch:', error.message);
            return of([]);
          }),
        ),
      );

      // return as Map for O(1) lookup
      const userMap = new Map<string, UserDto>();
      for (const user of users || []) {
        userMap.set(user.id, user);
      }
      return userMap;
    } catch (error) {
      console.warn('Error fetching users batch:', error);
      return new Map();
    }
  }

  // get user rehearsal preferences (display + default session settings).
  // returns system defaults on failure or unknown user.
  async getUserRehearsalPreferences(
    userId: string,
  ): Promise<UserRehearsalPreferences> {
    const fallback: UserRehearsalPreferences = {
      display: { ...DISPLAY_DEFAULTS },
      sessionDefaults: { ...SESSION_DEFAULTS },
    };

    if (!userId) {
      return fallback;
    }

    try {
      const result = await firstValueFrom(
        this.authServiceClient
          .send<UserRehearsalPreferences | null>(
            'getUserRehearsalPreferences',
            userId,
          )
          .pipe(
            timeout(5000),
            catchError((error) => {
              console.warn(
                `Failed to fetch preferences for ${userId}:`,
                error.message,
              );
              return of(null);
            }),
          ),
      );
      return result ?? fallback;
    } catch (error) {
      console.warn(`Error fetching preferences for ${userId}:`, error);
      return fallback;
    }
  }

  // check if a user exists
  async userExists(userId: string): Promise<boolean> {
    if (!userId) {
      return false;
    }

    try {
      const result = await firstValueFrom(
        this.authServiceClient.send<boolean>('userExists', userId).pipe(
          timeout(3000),
          catchError(() => of(false)),
        ),
      );
      return result ?? false;
    } catch {
      return false;
    }
  }

  // enrich entities with user data
  // helper method for adding user info to entity lists
  //
  // @example
  // const recordings = await this.recordingRepo.findByProjectId(projectId);
  // const enriched = await this.authClient.enrichWithUsers(
  //   recordings,
  //   (r) => r.userId,
  //   (r, user) => ({ ...r, user }),
  // );
  async enrichWithUsers<T, R>(
    items: T[],
    getUserId: (item: T) => string | undefined | null,
    enrich: (item: T, user: UserDto | null) => R,
  ): Promise<R[]> {
    if (!items || items.length === 0) {
      return [];
    }

    // collect all user IDs
    const userIds = items.map(getUserId).filter((id): id is string => !!id);

    // fetch all users in one batch call
    const usersMap = await this.getUsersByIds(userIds);

    // enrich each item with its user
    return items.map((item) => {
      const userId = getUserId(item);
      const user = userId ? (usersMap.get(userId) ?? null) : null;
      return enrich(item, user);
    });
  }
}
