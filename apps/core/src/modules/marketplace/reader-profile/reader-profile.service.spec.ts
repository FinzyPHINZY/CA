/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Media,
  MediaType,
  OnboardingStatus,
  OnboardingStep,
  ReaderProfile,
  ReaderSessionRate,
  ReaderSocialLink,
  ReaderSpecialty,
  ReaderWorkSampleSourceType,
  ReaderWorkSample,
  User,
  UserRoleEntity,
  UserRole,
  WorkSampleType,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReaderProfileService } from './reader-profile.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...overrides,
  };
}

describe('ReaderProfileService', () => {
  let service: ReaderProfileService;

  let profileRepo: ReturnType<typeof mockRepository>;
  let userRepo: ReturnType<typeof mockRepository>;
  let specialtyRepo: ReturnType<typeof mockRepository>;
  let workSampleRepo: ReturnType<typeof mockRepository>;
  let mediaRepo: ReturnType<typeof mockRepository>;
  let sessionRateRepo: ReturnType<typeof mockRepository>;
  let socialLinkRepo: ReturnType<typeof mockRepository>;
  let roleRepo: ReturnType<typeof mockRepository>;

  const userId = 'user-1';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    profileRepo = mockRepository();
    userRepo = mockRepository();
    specialtyRepo = mockRepository();
    workSampleRepo = mockRepository();
    mediaRepo = mockRepository();
    sessionRateRepo = mockRepository();
    socialLinkRepo = mockRepository();
    roleRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[User.name] = userRepo;
    repoMap[ReaderSpecialty.name] = specialtyRepo;
    repoMap[ReaderWorkSample.name] = workSampleRepo;
    repoMap[Media.name] = mediaRepo;
    repoMap[ReaderSessionRate.name] = sessionRateRepo;
    repoMap[ReaderSocialLink.name] = socialLinkRepo;
    repoMap[UserRoleEntity.name] = roleRepo;

    const mockManager = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    service = new ReaderProfileService(mockDataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── startOnboarding ──────────────────────────────────────────────

  describe('startOnboarding', () => {
    it('should create a reader profile and add reader role', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      roleRepo.findOne.mockResolvedValue({
        id: 'reader-role-id',
        code: UserRole.READER,
      });
      userRepo.findOne.mockResolvedValue({
        id: userId,
        role: { id: 'actor-role-id', code: UserRole.ACTOR },
      });

      const result = await service.startOnboarding(userId, {});

      expect(result.data.userId).toBe(userId);
      expect(result.data.onboardingStatus).toBe(OnboardingStatus.IN_PROGRESS);
      expect(result.data.onboardingStep).toBe(OnboardingStep.BIO);
      expect(profileRepo.save).toHaveBeenCalled();
      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          roleId: 'reader-role-id',
          role: expect.objectContaining({ code: UserRole.READER }),
        }),
      );
    });

    it('should set timezone on user if provided', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      roleRepo.findOne.mockResolvedValue({
        id: 'reader-role-id',
        code: UserRole.READER,
      });
      userRepo.findOne.mockResolvedValue({
        id: userId,
        role: { id: 'actor-role-id', code: UserRole.ACTOR },
      });

      await service.startOnboarding(userId, { timezone: 'America/New_York' });

      expect(userRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'America/New_York' }),
      );
    });

    it('should throw ConflictException if profile already exists', async () => {
      profileRepo.findOne.mockResolvedValue({ id: 'existing', userId });

      await expect(service.startOnboarding(userId, {})).rejects.toThrow(
        ConflictException,
      );
    });

    it('should not duplicate reader role if already present', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      userRepo.findOne.mockResolvedValue({
        id: userId,
        role: { id: 'reader-role-id', code: UserRole.READER },
      });

      await service.startOnboarding(userId, {});

      expect(userRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── updateProfileBasics ─────────────────────────────────────────

  describe('updateProfileBasics', () => {
    it('should update bio and headline', async () => {
      profileRepo.findOne.mockResolvedValue({
        userId,
        onboardingStep: OnboardingStep.BIO,
      });

      const result = await service.updateProfileBasics(userId, {
        bio: 'My bio',
        headline: 'Great reader',
      });

      expect(result.data.bio).toBe('My bio');
      expect(result.data.headline).toBe('Great reader');
    });

    it('should advance onboarding step from bio to specialties when updating profile basics', async () => {
      profileRepo.findOne.mockResolvedValue({
        userId,
        onboardingStep: OnboardingStep.BIO,
      });

      const result = await service.updateProfileBasics(userId, {
        bio: 'Bio',
      });

      expect(result.data.onboardingStep).toBe(OnboardingStep.SPECIALTIES);
    });

    it('should not advance step if not on bio', async () => {
      profileRepo.findOne.mockResolvedValue({
        userId,
        onboardingStep: OnboardingStep.SESSION_RATES,
      });

      const result = await service.updateProfileBasics(userId, {
        bio: 'Updated',
      });

      expect(result.data.onboardingStep).toBe(OnboardingStep.SESSION_RATES);
    });

    it('should throw NotFoundException if profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateProfileBasics(userId, { bio: 'Bio' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── updateSpecialties ────────────────────────────────────────────

  describe('updateSpecialties', () => {
    it('should replace specialties and advance step', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.SPECIALTIES,
      });

      const result = await service.updateSpecialties(userId, {
        genres: ['Drama', 'Comedy'],
      });

      expect(specialtyRepo.delete).toHaveBeenCalledWith({
        readerProfileId: 'profile-1',
      });
      expect(specialtyRepo.save).toHaveBeenCalled();
      expect(result.data.onboardingStep).toBe(OnboardingStep.WORK_SAMPLES);
    });

    it('should deduplicate genres', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.SPECIALTIES,
      });

      await service.updateSpecialties(userId, {
        genres: ['Drama', 'Drama', 'Comedy', ' '],
      });

      const savedSpecialties = specialtyRepo.save.mock.calls[0][0];
      expect(savedSpecialties).toHaveLength(2);
    });
  });

  // ─── updateWorkSamples ────────────────────────────────────────────

  describe('updateWorkSamples', () => {
    it('should replace external-link samples and advance step', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.WORK_SAMPLES,
      });

      const result = await service.updateWorkSamples(userId, {
        samples: [
          {
            title: 'Reel 1',
            sourceType: ReaderWorkSampleSourceType.EXTERNAL_LINK,
            url: 'https://example.com/reel',
            type: WorkSampleType.VIDEO,
          },
        ],
      });

      expect(workSampleRepo.delete).toHaveBeenCalled();
      expect(workSampleRepo.save).toHaveBeenCalled();
      expect(result.data.onboardingStep).toBe(OnboardingStep.SESSION_RATES);
    });

    it('should accept owned uploaded media and derive url from media record', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.WORK_SAMPLES,
      });
      mediaRepo.findOne.mockResolvedValue({
        id: 'media-1',
        userId,
        type: MediaType.VIDEO,
        url: 'https://bucket.s3.amazonaws.com/work-sample.mp4',
      });

      await service.updateWorkSamples(userId, {
        samples: [
          {
            title: 'Uploaded Reel',
            sourceType: ReaderWorkSampleSourceType.UPLOAD,
            mediaId: 'media-1',
            type: WorkSampleType.VIDEO,
          },
        ],
      });

      expect(mediaRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'media-1', userId },
      });
      expect(workSampleRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: ReaderWorkSampleSourceType.UPLOAD,
          mediaId: 'media-1',
          url: 'https://bucket.s3.amazonaws.com/work-sample.mp4',
        }),
      );
    });

    it('should reject uploaded media that does not belong to the user', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.WORK_SAMPLES,
      });
      mediaRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateWorkSamples(userId, {
          samples: [
            {
              title: 'Foreign Upload',
              sourceType: ReaderWorkSampleSourceType.UPLOAD,
              mediaId: 'media-foreign',
              type: WorkSampleType.VIDEO,
            },
          ],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should support mixed uploaded and external-link payloads', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.WORK_SAMPLES,
      });
      mediaRepo.findOne.mockResolvedValue({
        id: 'media-1',
        userId,
        type: MediaType.AUDIO,
        url: 'https://bucket.s3.amazonaws.com/demo.mp3',
      });

      await service.updateWorkSamples(userId, {
        samples: [
          {
            title: 'Uploaded Demo',
            sourceType: ReaderWorkSampleSourceType.UPLOAD,
            mediaId: 'media-1',
            type: WorkSampleType.AUDIO,
          },
          {
            title: 'External Demo',
            sourceType: ReaderWorkSampleSourceType.EXTERNAL_LINK,
            url: 'https://example.com/demo-reel',
            type: WorkSampleType.VIDEO,
          },
        ],
      });

      const savedSamples = workSampleRepo.save.mock.calls[0][0];
      expect(savedSamples).toHaveLength(2);
      expect(savedSamples[0]).toEqual(
        expect.objectContaining({
          sourceType: ReaderWorkSampleSourceType.UPLOAD,
          mediaId: 'media-1',
        }),
      );
      expect(savedSamples[1]).toEqual(
        expect.objectContaining({
          sourceType: ReaderWorkSampleSourceType.EXTERNAL_LINK,
          mediaId: null,
        }),
      );
    });
  });

  // ─── updateSessionRates ───────────────────────────────────────────

  describe('updateSessionRates', () => {
    it('should replace rates and advance step', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.SESSION_RATES,
      });

      const result = await service.updateSessionRates(userId, {
        rates: [{ durationMinutes: 30, priceCents: 5000 }],
      });

      expect(sessionRateRepo.delete).toHaveBeenCalled();
      expect(sessionRateRepo.save).toHaveBeenCalled();
      expect(result.data.onboardingStep).toBe(OnboardingStep.PAYMENT_SETUP);
    });

    it('should default currency to USD', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.SESSION_RATES,
      });

      await service.updateSessionRates(userId, {
        rates: [{ durationMinutes: 60, priceCents: 10000 }],
      });

      const createdRate = sessionRateRepo.create.mock.calls[0][0];
      expect(createdRate.currency).toBe('USD');
    });
  });

  // ─── updateSocialLinks ────────────────────────────────────────────

  describe('updateSocialLinks', () => {
    it('should replace links without changing step', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.PAYMENT_SETUP,
      });

      const result = await service.updateSocialLinks(userId, {
        links: [{ platform: 'instagram', url: 'https://instagram.com/user' }],
      });

      expect(socialLinkRepo.delete).toHaveBeenCalled();
      expect(socialLinkRepo.save).toHaveBeenCalled();
      expect(result.data.onboardingStep).toBe(OnboardingStep.PAYMENT_SETUP);
    });

    it('should handle empty links array', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStep: OnboardingStep.PAYMENT_SETUP,
      });

      await service.updateSocialLinks(userId, { links: [] });

      expect(socialLinkRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── getOnboardingStatus ──────────────────────────────────────────

  describe('getOnboardingStatus', () => {
    it('should return NOT_STARTED when no profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      const result = await service.getOnboardingStatus(userId);

      expect(result.data.hasProfile).toBe(false);
      expect(result.data.onboardingStatus).toBe(OnboardingStatus.NOT_STARTED);
      expect(result.data.steps.bio).toBe(false);
      expect(result.data.steps.specialties).toBe(false);
    });

    it('should return step completion for existing profile', async () => {
      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        onboardingStatus: OnboardingStatus.IN_PROGRESS,
        onboardingStep: OnboardingStep.SESSION_RATES,
        bio: 'Bio',
        specialties: [{ genre: 'Drama' }],
        workSamples: [],
        sessionRates: [],
        socialLinks: [],
        stripeOnboardingComplete: false,
        isAcceptingBookings: false,
      });

      const result = await service.getOnboardingStatus(userId);

      expect(result.data.hasProfile).toBe(true);
      expect(result.data.steps.bio).toBe(true);
      expect(result.data.steps.specialties).toBe(true);
      expect(result.data.steps.work_samples).toBe(false);
      expect(result.data.steps.session_rates).toBe(false);
    });
  });

  // ─── completeOnboarding ───────────────────────────────────────────

  describe('completeOnboarding', () => {
    it('should complete onboarding when all requirements met', async () => {
      profileRepo.findOne.mockResolvedValue({
        userId,
        bio: 'Bio',
        headline: 'Headline',
        specialties: [{ genre: 'Drama' }],
        sessionRates: [{ priceCents: 5000 }],
        stripeOnboardingComplete: true,
        onboardingStatus: OnboardingStatus.IN_PROGRESS,
      });

      const result = await service.completeOnboarding(userId);

      expect(result.data.onboardingStatus).toBe(OnboardingStatus.COMPLETED);
      expect(result.data.onboardingStep).toBe(OnboardingStep.COMPLETED);
      expect(result.data.isAcceptingBookings).toBe(true);
    });

    it('should throw if profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.completeOnboarding(userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should complete onboarding with isAcceptingBookings false when no session rates', async () => {
      profileRepo.findOne.mockResolvedValue({
        userId,
        specialties: [],
        sessionRates: [],
        stripeOnboardingComplete: false,
        onboardingStatus: OnboardingStatus.IN_PROGRESS,
      });

      const result = await service.completeOnboarding(userId);

      expect(result.data.onboardingStatus).toBe(OnboardingStatus.COMPLETED);
      expect(result.data.isAcceptingBookings).toBe(false);
    });
  });

  // ─── getMyProfile ─────────────────────────────────────────────────

  describe('getMyProfile', () => {
    it('should return profile with relations', async () => {
      const profile = {
        id: 'profile-1',
        userId,
        sessionRates: [],
        specialties: [],
        workSamples: [
          {
            id: 'sample-1',
            title: 'Uploaded Reel',
            url: 'https://bucket.s3.amazonaws.com/work-sample.mp4',
            thumbnailUrl: null,
            type: WorkSampleType.VIDEO,
            sourceType: ReaderWorkSampleSourceType.UPLOAD,
            mediaId: 'media-1',
            createdAt: new Date('2026-03-13T00:00:00.000Z'),
            updatedAt: new Date('2026-03-13T00:00:00.000Z'),
          },
        ],
      };
      profileRepo.findOne.mockResolvedValue(profile);

      const result = await service.getMyProfile(userId);

      expect(result.data.id).toBe('profile-1');
      expect(result.data.workSamples[0]).toEqual(
        expect.objectContaining({
          sourceType: ReaderWorkSampleSourceType.UPLOAD,
          mediaId: 'media-1',
        }),
      );
    });

    it('should throw if profile not found', async () => {
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.getMyProfile(userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── updateProfile ────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('should update fields without changing onboarding step', async () => {
      profileRepo.findOne.mockResolvedValue({
        userId,
        onboardingStep: OnboardingStep.COMPLETED,
        bio: 'Old bio',
      });

      const result = await service.updateProfile(userId, {
        bio: 'New bio',
      });

      expect(result.data.bio).toBe('New bio');
      expect(result.data.onboardingStep).toBe(OnboardingStep.COMPLETED);
    });
  });
});
