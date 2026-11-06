/** biome-ignore-all lint/style/useImportType: <> */

import {
  AuthClientService,
  Rehersal,
  RehearsalPartnerType,
  RehearsalReview,
  UserDto,
} from '@app/common';
import { RehearsalStatus } from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateRehearsalReviewDto,
  UpdateRehearsalReviewDto,
} from './dto/create-rehearsal-review.dto';

const REVIEW_EDIT_WINDOW_HOURS = 48;

export interface ReviewerSummary {
  id: string;
  fullName: string | null;
  avatar: string | null;
}

export type EnrichedRehearsalReview = RehearsalReview & {
  reviewer: ReviewerSummary | null;
};

@Injectable()
export class RehearsalReviewService {
  private readonly logger = new Logger(RehearsalReviewService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly authClient: AuthClientService,
  ) {}

  private toReviewerSummary(user: UserDto | null): ReviewerSummary | null {
    if (!user) return null;
    return { id: user.id, fullName: user.fullName, avatar: user.avatar };
  }

  private async enrichOne(
    review: RehearsalReview,
  ): Promise<EnrichedRehearsalReview> {
    const user = await this.authClient.getUserById(review.reviewerUserId);
    return { ...review, reviewer: this.toReviewerSummary(user) };
  }

  // submit a review for the other participant in a completed USER-partnered rehearsal.
  async createRehearsalReview(
    rehearsalId: string,
    reviewerUserId: string,
    dto: CreateRehearsalReviewDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const rehersalRepo = manager.getRepository(Rehersal);
      const reviewRepo = manager.getRepository(RehearsalReview);

      const rehearsal = await rehersalRepo.findOne({
        where: { id: rehearsalId },
      });
      if (!rehearsal) throw new NotFoundException('Rehearsal not found');

      if (rehearsal.rehearsalPartnerType !== RehearsalPartnerType.USER) {
        throw new BadRequestException(
          'Reviews are only available for user-partnered rehearsals',
        );
      }
      if (rehearsal.status !== RehearsalStatus.COMPLETED) {
        throw new BadRequestException('Can only review completed rehearsals');
      }

      const isOwner = rehearsal.userId === reviewerUserId;
      const isPartner = rehearsal.rehearsalPartnerUserId === reviewerUserId;
      if (!isOwner && !isPartner) {
        throw new ForbiddenException(
          'You were not a participant in this rehearsal',
        );
      }

      const revieweeUserId = isOwner
        ? rehearsal.rehearsalPartnerUserId
        : rehearsal.userId;

      const existing = await reviewRepo.findOne({
        where: { rehearsalId, reviewerUserId },
      });
      if (existing) {
        throw new ConflictException('You have already reviewed this rehearsal');
      }

      const review = reviewRepo.create({
        rehearsalId,
        reviewerUserId,
        revieweeUserId,
        rating: dto.rating,
        comment: dto.comment,
      });
      const savedReview = await reviewRepo.save(review);

      this.logger.log(
        `Rehearsal review created for rehearsal ${rehearsalId} by user ${reviewerUserId}`,
      );
      return savedReview;
    });

    return {
      success: true,
      message: 'Review created successfully',
      data: await this.enrichOne(result),
    };
  }

  // edit a rehearsal review within the 48-hour window.
  async updateRehearsalReview(
    reviewId: string,
    reviewerUserId: string,
    dto: UpdateRehearsalReviewDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const reviewRepo = manager.getRepository(RehearsalReview);

      const review = await reviewRepo.findOne({ where: { id: reviewId } });
      if (!review) throw new NotFoundException('Review not found');
      if (review.reviewerUserId !== reviewerUserId) {
        throw new ForbiddenException('Not your review');
      }

      const hoursSinceCreation =
        (Date.now() - review.createdAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceCreation > REVIEW_EDIT_WINDOW_HOURS) {
        throw new BadRequestException(
          `Reviews can only be edited within ${REVIEW_EDIT_WINDOW_HOURS} hours of creation`,
        );
      }

      if (dto.rating !== undefined) review.rating = dto.rating;
      if (dto.comment !== undefined) review.comment = dto.comment;
      const updated = await reviewRepo.save(review);

      return updated;
    });

    return {
      success: true,
      message: 'Review updated successfully',
      data: await this.enrichOne(result),
    };
  }

  // list all reviews received by a user from rehearsal sessions (paginated).
  async listReviewsReceived(
    revieweeUserId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const reviewRepo = this.dataSource.getRepository(RehearsalReview);
    const offset = (page - 1) * limit;

    const [data, total] = await reviewRepo.findAndCount({
      where: { revieweeUserId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);

    // Batch-fetch reviewer UserDtos in one TCP round-trip and attach to each item.
    const items = await this.authClient.enrichWithUsers<
      RehearsalReview,
      EnrichedRehearsalReview
    >(
      data,
      (r) => r.reviewerUserId,
      (r, user) => ({ ...r, reviewer: this.toReviewerSummary(user) }),
    );

    return {
      success: true,
      message: 'Reviews retrieved successfully',
      data: {
        items,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }
}
