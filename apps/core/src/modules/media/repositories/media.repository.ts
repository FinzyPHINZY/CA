import { Injectable } from '@nestjs/common';
import { DataSource, Brackets } from 'typeorm';
import { Media } from '../entities/media.entity';
import { BaseRepository } from '@app/common';

@Injectable()
export class MediaRepository extends BaseRepository<Media> {
  constructor(dataSource: DataSource) {
    super(Media, dataSource.manager);
  }

  /**
   * Find media by ID
   */
  async findById(id: string): Promise<Media | null> {
    return super.findById(id);
  }

  /**
   * Find media by ID or throw error
   */
  async findByIdOrFail(id: string): Promise<Media> {
    return super.findByIdOrFail(id);
  }

  /**
   * Find media by user ID
   */
  async findByUserId(userId: string): Promise<Media[]> {
    return this.findManyBy({ userId } as any);
  }

  /**
   * Create media
   */
  async createMedia(mediaData: Partial<Media>): Promise<Media> {
    return this.createEntity(mediaData);
  }

  /**
   * Update media
   */
  async updateMedia(
    id: string,
    mediaData: Partial<Media>,
  ): Promise<Media | null> {
    return this.updateByIdAndReturn(id, mediaData);
  }

  /**
   * Delete media by ID
   */
  async deleteMedia(id: string): Promise<void> {
    await this.hardDelete(id);
  }

  /**
   * Find media by user ID with pagination, search, sort, and filter
   */
  async findByUserIdWithPagination(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<{ data: Media[]; total: number; page: number; limit: number }> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = 'createdAt',
      sortOrder = 'DESC',
    } = options;

    const queryBuilder = this.createQueryBuilder('media')
      .where('media.userId = :userId', { userId })
      .orderBy(`media.${sortBy}`, sortOrder)
      .skip((page - 1) * limit)
      .take(limit);

    if (search) {
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('LOWER(media.fileName) LIKE LOWER(:search)', {
            search: `%${search}%`,
          }).orWhere('LOWER(media.url) LIKE LOWER(:search)', {
            search: `%${search}%`,
          });
        }),
      );
    }

    const [data, total] = await queryBuilder.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
    };
  }
}
