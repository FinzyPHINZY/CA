import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserTeleprompterPreference } from '../entities/user-teleprompter-preference.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class UserTeleprompterPreferenceRepository extends BaseRepository<UserTeleprompterPreference> {
  constructor(dataSource: DataSource) {
    super(UserTeleprompterPreference, dataSource.manager);
  }

  async findByUserId(
    userId: string,
  ): Promise<UserTeleprompterPreference | null> {
    return this.findOne({
      where: { userId },
      withDeleted: false,
    });
  }

  async upsertByUserId(
    userId: string,
    data: Partial<UserTeleprompterPreference>,
  ): Promise<UserTeleprompterPreference> {
    const existing = await this.findByUserId(userId);
    if (existing) {
      Object.assign(existing, data);
      return this.save(existing);
    }
    return this.createEntity({ ...data, userId });
  }
}
