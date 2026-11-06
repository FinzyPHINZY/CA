/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
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
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FeedbackNotificationService } from './feedback-notification.service';
import { ReviewService } from './review.service';

// helper to build a mock TypeORM repository
function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) =>
      Promise.resolve({ id: 'new-review-id', ...entity }),
    ),
    ...overrides,
  };
}

describe('ReviewService', () => {
  let service: ReviewService;
  let mockDataSource: jest.Mocked<Partial<DataSource>>;

  let bookingRepo: ReturnType<typeof mockRepository>;
  let reviewRepo: ReturnType<typeof mockRepository>;
  let profileRepo: ReturnType<typeof mockRepository>;
  let userRepo: ReturnType<typeof mockRepository>;

  const actorUserId = 'actor-user-1';
  const readerProfileId = 'reader-profile-1';
  const bookingId = 'booking-1';

  const completedBooking: Partial<Booking> = {
    id: bookingId,
    actorUserId,
    readerUserId: 'reader-user-1',
    readerProfileId,
    status: BookingStatus.COMPLETED,
  };

  const readerProfile: Partial<ReaderProfile> = {
    id: readerProfileId,
    avgRating: 4.0,
    totalReviews: 10,
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    bookingRepo = mockRepository();
    reviewRepo = mockRepository();
    profileRepo = mockRepository();
    userRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[Booking.name] = bookingRepo;
    repoMap[ReaderReview.name] = reviewRepo;
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[User.name] = userRepo;

    const mockManager = {
      getRepository: jest.fn((entity) => repoMap[entity.name]),
    };

    mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as jest.Mocked<Partial<DataSource>>;

    const mockFeedbackNotificationService = {
      markFeedbackSubmitted: jest.fn().mockResolvedValue(undefined),
    } as unknown as FeedbackNotificationService;

    service = new ReviewService(
      mockDataSource as unknown as DataSource,
      mockFeedbackNotificationService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createReview', () => {
    it('should create a review for a completed booking', async () => {
      bookingRepo.findOne.mockResolvedValue(completedBooking);
      reviewRepo.findOne.mockResolvedValue(null); // no existing review
      profileRepo.findOne.mockResolvedValue({ ...readerProfile });

      const result = await service.createReview(bookingId, actorUserId, {
        rating: 5,
        comment: 'Great session!',
      });

      expect(result).toBeDefined();
      expect(result.data.rating).toBe(5);
      expect(result.data.comment).toBe('Great session!');
      expect(result.data.bookingId).toBe(bookingId);
      expect(result.data.reviewerUserId).toBe(actorUserId);
      expect(reviewRepo.save).toHaveBeenCalled();
    });

    it('should reject if booking not found', async () => {
      bookingRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createReview(bookingId, actorUserId, { rating: 5 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if user is not the actor on the booking', async () => {
      bookingRepo.findOne.mockResolvedValue(completedBooking);

      await expect(
        service.createReview(bookingId, 'wrong-user', { rating: 5 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject if booking is not completed', async () => {
      bookingRepo.findOne.mockResolvedValue({
        ...completedBooking,
        status: BookingStatus.CONFIRMED,
      });

      await expect(
        service.createReview(bookingId, actorUserId, { rating: 5 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject duplicate review for same booking', async () => {
      bookingRepo.findOne.mockResolvedValue(completedBooking);
      reviewRepo.findOne.mockResolvedValue({ id: 'existing-review' }); // already reviewed

      await expect(
        service.createReview(bookingId, actorUserId, { rating: 5 }),
      ).rejects.toThrow(ConflictException);
    });

    it('should recalculate avgRating using running average', async () => {
      const profile = { ...readerProfile, avgRating: 4.0, totalReviews: 10 };
      bookingRepo.findOne.mockResolvedValue(completedBooking);
      reviewRepo.findOne.mockResolvedValue(null);
      profileRepo.findOne.mockResolvedValue(profile);

      await service.createReview(bookingId, actorUserId, { rating: 5 });

      // expected: (4.0 * 10 + 5) / 11 = 45 / 11 ≈ 4.09
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          avgRating: expect.closeTo(4.09, 1),
          totalReviews: 11,
        }),
      );
    });

    it('should set avgRating correctly for first review', async () => {
      const profile = { ...readerProfile, avgRating: 0, totalReviews: 0 };
      bookingRepo.findOne.mockResolvedValue(completedBooking);
      reviewRepo.findOne.mockResolvedValue(null);
      profileRepo.findOne.mockResolvedValue(profile);

      await service.createReview(bookingId, actorUserId, { rating: 3 });

      // expected: (0 * 0 + 3) / 1 = 3.0
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          avgRating: 3.0,
          totalReviews: 1,
        }),
      );
    });
  });

  describe('updateReview', () => {
    const existingReview: Partial<ReaderReview> = {
      id: 'review-1',
      reviewerUserId: actorUserId,
      readerProfileId,
      bookingId,
      rating: 4,
      comment: 'Good',
      createdAt: new Date(), // just created — within 48h window
    };

    it('should allow editing within 48h window', async () => {
      reviewRepo.findOne.mockResolvedValue({ ...existingReview });
      profileRepo.findOne.mockResolvedValue({ ...readerProfile });

      const result = await service.updateReview('review-1', actorUserId, {
        comment: 'Updated comment',
      });

      expect(result.data.comment).toBe('Updated comment');
      expect(reviewRepo.save).toHaveBeenCalled();
    });

    it('should reject editing after 48h window', async () => {
      const oldDate = new Date();
      oldDate.setHours(oldDate.getHours() - 49); // 49 hours ago

      reviewRepo.findOne.mockResolvedValue({
        ...existingReview,
        createdAt: oldDate,
      });

      await expect(
        service.updateReview('review-1', actorUserId, { comment: 'Too late' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if review not found', async () => {
      reviewRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateReview('nonexistent', actorUserId, { rating: 3 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if user is not the reviewer', async () => {
      reviewRepo.findOne.mockResolvedValue({ ...existingReview });

      await expect(
        service.updateReview('review-1', 'wrong-user', { rating: 3 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should recalculate avgRating when rating changes', async () => {
      const profile = { ...readerProfile, avgRating: 4.0, totalReviews: 10 };
      reviewRepo.findOne.mockResolvedValue({
        ...existingReview,
        rating: 4, // old rating
      });
      profileRepo.findOne.mockResolvedValue(profile);

      await service.updateReview('review-1', actorUserId, { rating: 2 });

      // expected: (4.0 * 10 - 4 + 2) / 10 = 38 / 10 = 3.8
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          avgRating: 3.8,
        }),
      );
    });

    it('should not recalculate avgRating when only comment changes', async () => {
      reviewRepo.findOne.mockResolvedValue({ ...existingReview });

      await service.updateReview('review-1', actorUserId, {
        comment: 'New comment only',
      });

      // profileRepo.save should not be called (no rating change)
      expect(profileRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('listReviewsForReader', () => {
    it('should return paginated results with reviewer info', async () => {
      const reviews = [
        { id: '1', rating: 5, reviewerUserId: 'user-a' },
        { id: '2', rating: 4, reviewerUserId: 'user-b' },
      ];
      reviewRepo.findAndCount.mockResolvedValue([reviews, 12]);
      userRepo.find.mockResolvedValue([
        { id: 'user-a', fullName: 'Ada Lovelace', avatar: 'https://cdn/a.jpg' },
        { id: 'user-b', fullName: 'Bo Smith', avatar: null },
      ]);

      const result = await service.listReviewsForReader(readerProfileId, 1, 10);

      expect(result.data.items).toHaveLength(2);
      expect(result.data.items[0].reviewer).toEqual({
        id: 'user-a',
        name: 'Ada Lovelace',
        avatar: 'https://cdn/a.jpg',
      });
      expect(result.data.items[1].reviewer).toEqual({
        id: 'user-b',
        name: 'Bo Smith',
        avatar: null,
      });
      expect(result.data.total).toBe(12);
      expect(result.data.page).toBe(1);
      expect(result.data.totalPages).toBe(2);
      expect(result.data.hasNext).toBe(true);
      expect(result.data.hasPrev).toBe(false);
    });

    it('should null reviewer name/avatar when user no longer exists', async () => {
      const reviews = [{ id: '1', rating: 5, reviewerUserId: 'deleted-user' }];
      reviewRepo.findAndCount.mockResolvedValue([reviews, 1]);
      userRepo.find.mockResolvedValue([]);

      const result = await service.listReviewsForReader(readerProfileId, 1, 10);

      expect(result.data.items[0].reviewer).toEqual({
        id: 'deleted-user',
        name: null,
        avatar: null,
      });
    });

    it('should return hasNext=false on last page', async () => {
      reviewRepo.findAndCount.mockResolvedValue([[], 10]);

      const result = await service.listReviewsForReader(readerProfileId, 1, 10);

      expect(result.data.totalPages).toBe(1);
      expect(result.data.hasNext).toBe(false);
    });

    it('should return hasPrev=true on page > 1', async () => {
      reviewRepo.findAndCount.mockResolvedValue([[], 20]);

      const result = await service.listReviewsForReader(readerProfileId, 2, 10);

      expect(result.data.hasPrev).toBe(true);
    });
  });
});
