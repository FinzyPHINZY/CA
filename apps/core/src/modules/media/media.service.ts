import { Injectable, NotFoundException } from '@nestjs/common';
import { Media } from './entities/media.entity';
import { MediaRepository } from './repositories/media.repository';

@Injectable()
export class MediaService {
  constructor(private readonly mediaRepository: MediaRepository) {}

  async findById(
    id: string,
  ): Promise<{ success: boolean; message: string; data: Media }> {
    const media = await this.mediaRepository.findById(id);
    if (!media) {
      throw new NotFoundException(`Media with ID ${id} not found`);
    }
    return {
      success: true,
      message: 'Media retrieved successfully',
      data: media,
    };
  }

  async findByUserId(userId: string): Promise<Media[]> {
    return this.mediaRepository.findByUserId(userId);
  }

  async findByUserIdPaginated(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    const { data, total, page, limit } =
      await this.mediaRepository.findByUserIdWithPagination(userId, options);

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      message: 'Media retrieved successfully',
      data: { items: data, total, page, limit, totalPages, hasNext, hasPrev },
    };
  }

  async create(mediaData: Partial<Media>): Promise<Media> {
    return this.mediaRepository.createMedia(mediaData);
  }

  async update(
    id: string,
    mediaData: Partial<Media>,
  ): Promise<{ success: boolean; message: string; data: Media }> {
    const updated = await this.mediaRepository.updateMedia(id, mediaData);
    if (!updated) {
      throw new NotFoundException(`Media with ID ${id} not found`);
    }
    return {
      success: true,
      message: 'Media updated successfully',
      data: updated,
    };
  }

  async delete(id: string): Promise<void> {
    await this.mediaRepository.deleteMedia(id);
  }
}
