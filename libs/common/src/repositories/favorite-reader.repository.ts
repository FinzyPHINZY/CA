import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FavoriteReader } from '../entities/favorite-reader.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class FavoriteReaderRepository extends BaseRepository<FavoriteReader> {
  constructor(dataSource: DataSource) {
    super(FavoriteReader, dataSource.manager);
  }

  async findByUserId(userId: string): Promise<FavoriteReader[]> {
    return this.findManyBy({ userId });
  }

  async findByUserAndReader(
    userId: string,
    readerProfileId: string,
  ): Promise<FavoriteReader | null> {
    return this.findOneBy({ userId, readerProfileId });
  }
}
