import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReaderReview } from '../entities/reader-review.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class ReaderReviewRepository extends BaseRepository<ReaderReview> {
  constructor(dataSource: DataSource) {
    super(ReaderReview, dataSource.manager);
  }

  async findByReaderProfileId(
    readerProfileId: string,
  ): Promise<ReaderReview[]> {
    return this.findManyBy({ readerProfileId });
  }

  async findByBookingId(bookingId: string): Promise<ReaderReview | null> {
    return this.findOneBy({ bookingId });
  }
}
