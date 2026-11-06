import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReaderProfile } from '../entities/reader-profile.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class ReaderProfileRepository extends BaseRepository<ReaderProfile> {
  constructor(dataSource: DataSource) {
    super(ReaderProfile, dataSource.manager);
  }

  async findByUserId(userId: string): Promise<ReaderProfile | null> {
    return this.findOne({
      where: { userId },
      relations: ['sessionRates', 'specialties', 'workSamples', 'socialLinks'],
    });
  }

  async findByUserIdOrFail(userId: string): Promise<ReaderProfile> {
    return this.findOneOrFail({
      where: { userId },
      relations: ['sessionRates', 'specialties', 'workSamples', 'socialLinks'],
    });
  }
}
