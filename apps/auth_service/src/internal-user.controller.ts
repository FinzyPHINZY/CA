/** biome-ignore-all lint/style/useImportType: <> */
import {
  DISPLAY_DEFAULTS,
  DisplayPreferences,
  SESSION_DEFAULTS,
  SessionSettings,
  User,
} from '@app/common';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { DataSource } from 'typeorm';

@Controller()
export class InternalUserController {
  constructor(private readonly dataSource: DataSource) {}

  // get a single user by ID
  // used when services need user details for display like "Recording by John Doe"
  @MessagePattern('getUserById')
  async getUserById(@Payload() userId: string) {
    if (!userId) {
      return null;
    }

    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId },
      relations: { role: true },
      select: {
        id: true,
        email: true,
        fullName: true,
        avatar: true,
        timezone: true,
        roleId: true,
        role: { id: true, code: true },
      },
    });

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatar: user.avatar,
      roles: user.roles,
      timezone: user.timezone,
    };
  }

  // get multiple users by IDs (batch operation)
  // used when services need to fetch user details for multiple entities at once and is more efficient than making multiple individual calls
  @MessagePattern('getUsersByIds')
  async getUsersByIds(@Payload() userIds: string[]) {
    if (!userIds || userIds.length === 0) {
      return [];
    }

    const uniqueIds = [...new Set(userIds)];

    const userRepo = this.dataSource.getRepository(User);
    const users = await userRepo
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.email',
        'user.fullName',
        'user.avatar',
        'user.roleId',
        'user.timezone',
        'role.id',
        'role.code',
      ])
      .leftJoinAndSelect('user.role', 'role')
      .where('user.id IN (:...ids)', { ids: uniqueIds })
      .getMany();

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      avatar: user.avatar,
      roles: user.roles,
      timezone: user.timezone,
    }));
  }

  // check if a user exists, used this for validation without fetching full user data
  @MessagePattern('userExists')
  async userExists(@Payload() userId: string): Promise<boolean> {
    if (!userId) {
      return false;
    }

    const userRepo = this.dataSource.getRepository(User);
    const count = await userRepo.count({ where: { id: userId } });
    return count > 0;
  }

  // get user rehearsal preferences (display + default session settings) merged with system defaults.
  // used by core to resolve effective rehearsal session settings.
  @MessagePattern('getUserRehearsalPreferences')
  async getUserRehearsalPreferences(@Payload() userId: string): Promise<{
    display: DisplayPreferences;
    sessionDefaults: SessionSettings;
  } | null> {
    if (!userId) {
      return null;
    }

    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: { id: userId },
      select: ['id', 'displayPreferences', 'defaultSessionSettings'],
    });

    if (!user) {
      return null;
    }

    return {
      display: { ...DISPLAY_DEFAULTS, ...(user.displayPreferences ?? {}) },
      sessionDefaults: {
        ...SESSION_DEFAULTS,
        ...(user.defaultSessionSettings ?? {}),
      },
    };
  }
}
