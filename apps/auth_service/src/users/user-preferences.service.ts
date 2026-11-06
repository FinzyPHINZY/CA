import {
  DISPLAY_DEFAULTS,
  DisplayPreferences,
  SESSION_DEFAULTS,
  SessionSettings,
  User,
} from '@app/common';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UpdateDefaultSessionSettingsDto } from './dto/update-default-session-settings.dto';
import { UpdateDisplayPreferencesDto } from './dto/update-display-preferences.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

export interface ResolvedPreferences {
  display: DisplayPreferences;
  sessionDefaults: SessionSettings;
}

@Injectable()
export class UserPreferencesService {
  constructor(private readonly dataSource: DataSource) {}

  async getPreferences(userId: string): Promise<ResolvedPreferences> {
    if (!userId) {
      throw new UnauthorizedException('User ID is required');
    }

    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId },
      select: ['id', 'displayPreferences', 'defaultSessionSettings'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.merge(user.displayPreferences, user.defaultSessionSettings);
  }

  async updatePreferences(
    userId: string,
    dto: UpdatePreferencesDto,
  ): Promise<ResolvedPreferences> {
    if (!userId) {
      throw new UnauthorizedException('User ID is required');
    }

    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId },
      select: ['id', 'displayPreferences', 'defaultSessionSettings'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.display) {
      user.displayPreferences = this.mergeDisplay(
        user.displayPreferences,
        dto.display,
      );
    }

    if (dto.sessionDefaults) {
      user.defaultSessionSettings = this.mergeSession(
        user.defaultSessionSettings,
        dto.sessionDefaults,
      );
    }

    await userRepo.save(user);

    return this.merge(user.displayPreferences, user.defaultSessionSettings);
  }

  /** Internal: read raw stored values for inter-service consumption (resolver layer). */
  async getRawPreferences(userId: string): Promise<{
    display: DisplayPreferences | null;
    sessionDefaults: SessionSettings | null;
  }> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId },
      select: ['id', 'displayPreferences', 'defaultSessionSettings'],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      display: user.displayPreferences,
      sessionDefaults: user.defaultSessionSettings,
    };
  }

  private merge(
    display: DisplayPreferences | null,
    session: SessionSettings | null,
  ): ResolvedPreferences {
    return {
      display: { ...DISPLAY_DEFAULTS, ...(display ?? {}) },
      sessionDefaults: { ...SESSION_DEFAULTS, ...(session ?? {}) },
    };
  }

  private mergeDisplay(
    current: DisplayPreferences | null,
    patch: UpdateDisplayPreferencesDto,
  ): DisplayPreferences {
    const base = current ?? DISPLAY_DEFAULTS;
    const next: DisplayPreferences = { ...base };
    for (const key of Object.keys(
      patch,
    ) as (keyof UpdateDisplayPreferencesDto)[]) {
      const value = patch[key];
      if (value !== undefined) {
        (next as any)[key] = value;
      }
    }
    return next;
  }

  private mergeSession(
    current: SessionSettings | null,
    patch: UpdateDefaultSessionSettingsDto,
  ): SessionSettings {
    const base = current ?? SESSION_DEFAULTS;
    const next: SessionSettings = { ...base };
    for (const key of Object.keys(
      patch,
    ) as (keyof UpdateDefaultSessionSettingsDto)[]) {
      const value = patch[key];
      if (value !== undefined) {
        (next as any)[key] = value;
      }
    }
    return next;
  }
}
