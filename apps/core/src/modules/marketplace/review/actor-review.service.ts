/** biome-ignore-all lint/style/useImportType: <> */

import { ActorReview, Booking, BookingStatus, User } from '@app/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  CreateActorReviewDto,
  UpdateActorReviewDto,
} from './dto/create-actor-review.dto';
import { FeedbackNotificationService } from './feedback-notification.service';

const REVIEW_EDIT_WINDOW_HOURS = 48;

@Injectable()
export class ActorReviewService {
  private readonly logger = new Logger(ActorReviewService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly feedbackNotificationService: FeedbackNotificationService,
  ) {}

  // create a review for a completed booking. only the reader can review the actor. one review per booking.
  async createActorReview(
    bookingId: string,
    reviewerUserId: string,
    dto: CreateActorReviewDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const bookingRepo = manager.getRepository(Booking);
      const reviewRepo = manager.getRepository(ActorReview);
      const userRepo = manager.getRepository(User);

      const booking = await bookingRepo.findOne({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException('Booking not found');

      if (booking.readerUserId !== reviewerUserId) {
        throw new ForbiddenException('Only the reader can review this booking');
      }
      if (
        booking.status !== BookingStatus.COMPLETED &&
        booking.status !== BookingStatus.AWAITING_SETTLEMENT
      ) {
        throw new BadRequestException('Can only review completed bookings');
      }

      const existing = await reviewRepo.findOne({ where: { bookingId } });
      if (existing) {
        throw new ConflictException('A review already exists for this booking');
      }

      const review = reviewRepo.create({
        actorUserId: booking.actorUserId,
        reviewerUserId,
        bookingId,
        rating: dto.rating,
        comment: dto.comment,
      });
      const savedReview = await reviewRepo.save(review);

      // update actor's running average rating
      const actor = await userRepo.findOne({
        where: { id: booking.actorUserId },
      });
      if (actor) {
        const newTotal = actor.totalReviews + 1;
        actor.avgRating = Number(
          (
            (actor.avgRating * actor.totalReviews + dto.rating) /
            newTotal
          ).toFixed(2),
        );
        actor.totalReviews = newTotal;
        await userRepo.save(actor);
      }

      this.logger.log(
        `Actor review created for booking ${bookingId} by reader ${reviewerUserId}`,
      );
      return savedReview;
    });

    // mark the reader's feedback as submitted so reminders are suppressed
    this.feedbackNotificationService
      .markFeedbackSubmitted(bookingId, 'reader')
      .catch((err) =>
        this.logger.error(
          `Failed to mark reader feedback submitted for booking ${bookingId}: ${err.message}`,
        ),
      );

    return {
      success: true,
      message: 'Review created successfully',
      data: result,
    };
  }

  // edit a review within the 48-hour edit window.
  async updateActorReview(
    reviewId: string,
    reviewerUserId: string,
    dto: UpdateActorReviewDto,
  ) {
    const result = await this.dataSource.transaction(async (manager) => {
      const reviewRepo = manager.getRepository(ActorReview);
      const userRepo = manager.getRepository(User);

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

      // recalculate average if rating changed
      if (dto.rating !== undefined && dto.rating !== oldRating) {
        const actor = await userRepo.findOne({
          where: { id: review.actorUserId },
        });
        if (actor && actor.totalReviews > 0) {
          actor.avgRating = Number(
            (
              (actor.avgRating * actor.totalReviews - oldRating + dto.rating) /
              actor.totalReviews
            ).toFixed(2),
          );
          await userRepo.save(actor);
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

  // list reviews received by an actor (paginated).
  async listReviewsForActor(
    actorUserId: string,
    page: number = 1,
    limit: number = 10,
  ) {
    const reviewRepo = this.dataSource.getRepository(ActorReview);
    const offset = (page - 1) * limit;

    const [data, total] = await reviewRepo.findAndCount({
      where: { actorUserId },
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
  private async enrichReviewers(reviews: ActorReview[]) {
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
