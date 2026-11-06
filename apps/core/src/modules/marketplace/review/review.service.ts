/** biome-ignore-all lint/style/useImportType: <> */

import {
  Booking,
  BookingStatus,
  ReaderProfile,
  ReaderReview,
  User,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { CreateReviewDto, UpdateReviewDto } from './dto/create-review.dto';
import { FeedbackNotificationService } from './feedback-notification.service';

const REVIEW_EDIT_WINDOW_HOURS = 48;

@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly feedbackNotificationService: FeedbackNotificationService,
  ) {}

  // create a review for a completed booking. only the actor can review. one review per booking.
  async createReview(
    bookingId: string,
    reviewerUserId: string,
    dto: CreateReviewDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const reviewRepo = manager.getRepository(ReaderReview);
      const profileRepo = manager.getRepository(ReaderProfile);

      // validate booking
      const booking = await bookingRepo.findOne({
        where: { id: bookingId },
      });

      if (!booking) throw new NotFoundException('Booking not found');

      if (booking.actorUserId !== reviewerUserId) {
        throw new ForbiddenException('Only the actor can review this booking');
      }
      if (
        booking.status !== BookingStatus.COMPLETED &&
        booking.status !== BookingStatus.AWAITING_SETTLEMENT
      ) {
        throw new BadRequestException('Can only review completed bookings');
      }

      // check for existing review
      const existing = await reviewRepo.findOne({
        where: { bookingId },
      });

      if (existing) {
        throw new ConflictException('A review already exists for this booking');
      }

      // create review
      const review = reviewRepo.create({
        readerProfileId: booking.readerProfileId,
        reviewerUserId,
        bookingId,
        rating: dto.rating,
        comment: dto.comment,
      });
      const savedReview = await reviewRepo.save(review);

      // update reader's average rating (running average)
      const profile = await profileRepo.findOne({
        where: { id: booking.readerProfileId },
      });
      if (profile) {
        const newTotal = profile.totalReviews + 1;
        // running average: newAvg = (oldAvg * oldCount + newRating) / newCount
        profile.avgRating = Number(
          (
            (profile.avgRating * profile.totalReviews + dto.rating) /
            newTotal
          ).toFixed(2),
        );
        profile.totalReviews = newTotal;
        await profileRepo.save(profile);
      }

      this.logger.log(
        `Review created for booking ${bookingId} by user ${reviewerUserId}`,
      );
      return savedReview;
    });

    // mark the actor's feedback as submitted so reminders are suppressed
    this.feedbackNotificationService
      .markFeedbackSubmitted(bookingId, 'actor')
      .catch((err) =>
        this.logger.error(
          `Failed to mark actor feedback submitted for booking ${bookingId}: ${err.message}`,
        ),
      );

    return {
      success: true,
      message: 'Review created successfully',
      data: result,
    };
  }

  // edit a review within the 48-hour edit window.
  async updateReview(
    reviewId: string,
    reviewerUserId: string,
    dto: UpdateReviewDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const reviewRepo = manager.getRepository(ReaderReview);
      const profileRepo = manager.getRepository(ReaderProfile);

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

      const oldRating = review.rating;

      if (dto.rating !== undefined) review.rating = dto.rating;
      if (dto.comment !== undefined) review.comment = dto.comment;
      const updated = await reviewRepo.save(review);

      // if rating changed, recalculate average
      if (dto.rating !== undefined && dto.rating !== oldRating) {
        const profile = await profileRepo.findOne({
          where: { id: review.readerProfileId },
        });
        if (profile && profile.totalReviews > 0) {
          // remove old rating and add new rating
          profile.avgRating = Number(
            (
              (profile.avgRating * profile.totalReviews -
                oldRating +
                dto.rating) /
              profile.totalReviews
            ).toFixed(2),
          );
          await profileRepo.save(profile);
        }
      }

      return updated;
    });

    return {
      success: true,
      message: 'Review updated successfully',
      data: result,
    };
  }

  // list reviews for a reader profile (paginated).
  async listReviewsForReader(
    readerProfileId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const reviewRepo = this.dataSource.getRepository(ReaderReview);
    const offset = (page - 1) * limit;

    const [data, total] = await reviewRepo.findAndCount({
      where: { readerProfileId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    const items = await this.enrichReviewers(data);
    const totalPages = Math.ceil(total / limit);

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

  // attach reviewer: { id, name, avatar } to each review by bulk-fetching users.
  private async enrichReviewers(reviews: ReaderReview[]) {
    if (reviews.length === 0) return [];

    const userIds = [...new Set(reviews.map((r) => r.reviewerUserId))];
    const users = await this.dataSource.getRepository(User).find({
      where: { id: In(userIds) },
      select: ['id', 'fullName', 'avatar'],
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    return reviews.map((review) => {
      const user = userMap.get(review.reviewerUserId);
      return {
        ...review,
        reviewer: {
          id: review.reviewerUserId,
          name: user?.fullName ?? null,
          avatar: user?.avatar ?? null,
        },
      };
    });
  }
}
