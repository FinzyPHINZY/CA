import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { MediaRepository } from '../repositories/media.repository';
import { Media } from '../entities';
import { MediaType } from '../enums/enums';

/**
 * Service responsible for media operations
 * Follows Single Responsibility Principle - handles only media-related operations
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(private readonly mediaRepository: MediaRepository) {}

  /**
   * Find media by ID
   */
  async findById(id: string): Promise<Media> {
    const media = await this.mediaRepository.findById(id);
    if (!media) {
      throw new NotFoundException(`Media with ID ${id} not found`);
    }
    return media;
  }

  /**
   * Find media by user ID
   */
  async findByUserId(userId: string): Promise<Media[]> {
    return this.mediaRepository.findByUserId(userId);
  }

  /**
   * Find media by S3 key
   */
  async findByS3Key(s3Key: string): Promise<Media | null> {
    return this.mediaRepository.findByS3Key(s3Key);
  }

  /**
   * Create media record
   * Single Responsibility: Only creates media records
   */
  async createMedia(mediaData: {
    type: MediaType;
    url: string;
    size: number;
    userId: string;
    fileName?: string;
    contentType?: string;
    s3Key?: string;
    contentHash?: string;
    durationMs?: number | null;
  }): Promise<Media> {
    const media = await this.mediaRepository.createMedia(mediaData);
    this.logger.log(
      `Media record created: ${media.id} for user ${mediaData.userId}`,
    );
    return media;
  }

  /**
   * Update media record
   */
  async updateMedia(id: string, mediaData: Partial<Media>): Promise<Media> {
    const updated = await this.mediaRepository.updateMedia(id, mediaData);
    if (!updated) {
      throw new NotFoundException(`Media with ID ${id} not found`);
    }
    this.logger.log(`Media record updated: ${id}`);
    return updated;
  }

  /**
   * Delete media record
   */
  async deleteMedia(id: string): Promise<void> {
    await this.findById(id); // Verify media exists
    await this.mediaRepository.deleteMedia(id);
    this.logger.log(`Media record deleted: ${id}`);
  }

  /**
   * Find a
   */
  async findByUserIdAndMediaId(
    userId: string,
    mediaId: string,
  ): Promise<Media | null> {
    return this.mediaRepository.findByUserIdAndMediaId(userId, mediaId);
  }
}
