import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class UserRepository extends BaseRepository<User> {
  constructor(dataSource: DataSource) {
    super(User, dataSource.manager);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.findOne({ where: { email } });
  }

  async findByGoogleId(googleId: string): Promise<User | null> {
    return this.findOne({ where: { googleId } });
  }

  async findByAppleId(appleId: string): Promise<User | null> {
    return this.findOne({ where: { appleId } });
  }

  async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    return this.findOne({ where: { phoneNumber } });
  }

  async findByEmailOrGoogleIdOrAppleId(
    email?: string,
    googleId?: string,
    appleId?: string,
  ): Promise<User | null> {
    if (email) {
      const user = await this.findByEmail(email);
      if (user) return user;
    }
    if (googleId) {
      const user = await this.findByGoogleId(googleId);
      if (user) return user;
    }
    if (appleId) {
      const user = await this.findByAppleId(appleId);
      if (user) return user;
    }
    return null;
  }

  async createUser(user: Partial<User>): Promise<User> {
    return this.createEntity(user);
  }

  async findById(id: string): Promise<User | null> {
    return super.findById(id);
  }
}
