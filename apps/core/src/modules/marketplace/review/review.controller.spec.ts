/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { ActorReviewService } from './actor-review.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';

describe('ReviewController', () => {
  let controller: ReviewController;
  let reviewService: jest.Mocked<Partial<ReviewService>>;
  let actorReviewService: jest.Mocked<Partial<ActorReviewService>>;

  const mockReq = { user: { id: 'actor-1' } };

  beforeEach(() => {
    reviewService = {
      createReview: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { id: 'review-1', rating: 5 },
      }),
      updateReview: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { id: 'review-1', rating: 4 },
      }),
      listReviewsForReader: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { items: [], total: 0 },
      }),
    };

    actorReviewService = {
      createActorReview: jest.fn(),
      updateActorReview: jest.fn(),
      listReviewsForActor: jest.fn(),
    };

    controller = new ReviewController(
      reviewService as unknown as ReviewService,
      actorReviewService as unknown as ActorReviewService,
    );
  });

  describe('createReview', () => {
    it('should delegate with bookingId, userId, and DTO', async () => {
      const dto = { rating: 5, comment: 'Great!' };
      const result = await controller.createReview(
        mockReq,
        'booking-1',
        dto as any,
      );

      expect(reviewService.createReview).toHaveBeenCalledWith(
        'booking-1',
        'actor-1',
        dto,
      );
      expect(result.data.rating).toBe(5);
    });
  });

  describe('updateReview', () => {
    it('should delegate with reviewId, userId, and DTO', async () => {
      const dto = { comment: 'Updated comment' };
      await controller.updateReview(mockReq, 'review-1', dto as any);

      expect(reviewService.updateReview).toHaveBeenCalledWith(
        'review-1',
        'actor-1',
        dto,
      );
    });
  });

  describe('listReviewsForReader', () => {
    it('should delegate with profileId and pagination', async () => {
      await controller.listReviewsForReader('profile-1', 2, 10);

      expect(reviewService.listReviewsForReader).toHaveBeenCalledWith(
        'profile-1',
        2,
        10,
      );
    });

    it('should default page=1 and limit=10 when not provided', async () => {
      await controller.listReviewsForReader('profile-1');

      expect(reviewService.listReviewsForReader).toHaveBeenCalledWith(
        'profile-1',
        1,
        10,
      );
    });
  });
});
