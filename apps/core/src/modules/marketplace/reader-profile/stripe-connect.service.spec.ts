/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  OnboardingStatus,
  OnboardingStep,
  ReaderProfile,
  User,
} from '@app/common';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { StripeConnectService } from './stripe-connect.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    count: jest.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('StripeConnectService', () => {
  let service: StripeConnectService;

  let profileRepo: ReturnType<typeof mockRepository>;
  let userRepo: ReturnType<typeof mockRepository>;
  let specialtyRepo: ReturnType<typeof mockRepository>;
  let rateRepo: ReturnType<typeof mockRepository>;

  const userId = 'user-1';

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    profileRepo = mockRepository();
    userRepo = mockRepository();
    specialtyRepo = mockRepository();
    rateRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[User.name] = userRepo;

    // String-based repos used in handleOnboardingReturn
    const stringRepoMap: Record<string, ReturnType<typeof mockRepository>> = {
      ReaderSpecialty: specialtyRepo,
      ReaderSessionRate: rateRepo,
    };

    const mockManager = {
      getRepository: jest.fn((entity: any) => {
        if (typeof entity === 'string') return stringRepoMap[entity];
        return repoMap[entity.name];
      }),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    const mockConfigService = {
      get: jest.fn().mockReturnValue(null),
    } as unknown as ConfigService;

    service = new StripeConnectService(mockConfigService, mockDataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── createConnectAccount ─────────────────────────────────────────

  describe('createConnectAccount', () => {
    it('should throw if Stripe not configured', async () => {
      await expect(service.createConnectAccount(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw if profile not found', async () => {
      (service as any).stripe = {
        accounts: { create: jest.fn() },
        accountLinks: { create: jest.fn() },
      };
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.createConnectAccount(userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should generate new link if account already exists', async () => {
      const mockLink = { url: 'https://connect.stripe.com/onboard/existing' };
      (service as any).stripe = {
        accountLinks: { create: jest.fn().mockResolvedValue(mockLink) },
      };
      (service as any).configService = {
        get: jest.fn().mockReturnValue('http://localhost:3000'),
      };
      profileRepo.findOne.mockResolvedValue({
        userId,
        stripeAccountId: 'acct_existing',
      });

      const result = await service.createConnectAccount(userId);

      expect(result.data.url).toBe(mockLink.url);
      // Should NOT create a new account
      expect((service as any).stripe.accounts?.create).toBeUndefined();
    });

    it('should create new Express account and return link', async () => {
      const mockAccount = { id: 'acct_new_123' };
      const mockLink = { url: 'https://connect.stripe.com/onboard/new' };
      (service as any).stripe = {
        accounts: { create: jest.fn().mockResolvedValue(mockAccount) },
        accountLinks: { create: jest.fn().mockResolvedValue(mockLink) },
      };
      (service as any).configService = {
        get: jest.fn().mockReturnValue('http://localhost:3000'),
      };

      profileRepo.findOne.mockResolvedValue({
        id: 'profile-1',
        userId,
        stripeAccountId: null,
      });
      userRepo.findOne.mockResolvedValue({
        id: userId,
        email: 'reader@example.com',
      });

      const result = await service.createConnectAccount(userId);

      expect(result.data.url).toBe(mockLink.url);
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ stripeAccountId: 'acct_new_123' }),
      );
    });

    it('should throw if user has no email', async () => {
      (service as any).stripe = {
        accounts: { create: jest.fn() },
        accountLinks: { create: jest.fn() },
      };
      profileRepo.findOne.mockResolvedValue({
        userId,
        stripeAccountId: null,
      });
      userRepo.findOne.mockResolvedValue({ id: userId, email: null });

      await expect(service.createConnectAccount(userId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── refreshOnboardingLink ────────────────────────────────────────

  describe('refreshOnboardingLink', () => {
    it('should throw if Stripe not configured', async () => {
      await expect(service.refreshOnboardingLink(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw if no Stripe account found', async () => {
      (service as any).stripe = {
        accountLinks: { create: jest.fn() },
      };
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.refreshOnboardingLink(userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return new onboarding link', async () => {
      const mockLink = { url: 'https://connect.stripe.com/onboard/refresh' };
      (service as any).stripe = {
        accountLinks: { create: jest.fn().mockResolvedValue(mockLink) },
      };
      (service as any).configService = {
        get: jest.fn().mockReturnValue('http://localhost:3000'),
      };
      profileRepo.findOne.mockResolvedValue({
        userId,
        stripeAccountId: 'acct_123',
      });

      const result = await service.refreshOnboardingLink(userId);

      expect(result.data.url).toBe(mockLink.url);
    });
  });

  // ─── handleOnboardingReturn ───────────────────────────────────────

  describe('handleOnboardingReturn', () => {
    it('should throw if no Stripe account', async () => {
      (service as any).stripe = {
        accounts: { retrieve: jest.fn() },
      };
      profileRepo.findOne.mockResolvedValue(null);

      await expect(service.handleOnboardingReturn(userId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should return verified=true and update profile when fully verified', async () => {
      (service as any).stripe = {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
          }),
        },
      };
      profileRepo.findOne.mockResolvedValue({
        userId,
        stripeAccountId: 'acct_123',
        stripeOnboardingComplete: false,
        bio: 'Has bio',
        headline: 'Headline',
        id: 'profile-1',
      });
      specialtyRepo.count.mockResolvedValue(2);
      rateRepo.count.mockResolvedValue(1);

      const result = await service.handleOnboardingReturn(userId);

      expect(result.data.verified).toBe(true);
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          stripeOnboardingComplete: true,
          onboardingStep: OnboardingStep.COMPLETED,
          isAcceptingBookings: true,
        }),
      );
    });

    it('should return verified=false when not fully verified', async () => {
      (service as any).stripe = {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: false,
            payouts_enabled: false,
          }),
        },
      };
      profileRepo.findOne.mockResolvedValue({
        userId,
        stripeAccountId: 'acct_123',
        stripeOnboardingComplete: false,
      });

      const result = await service.handleOnboardingReturn(userId);

      expect(result.data.verified).toBe(false);
      expect(result.data.chargesEnabled).toBe(false);
      expect(profileRepo.save).not.toHaveBeenCalled();
    });

    it('should not re-verify if already complete', async () => {
      (service as any).stripe = {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
          }),
        },
      };
      profileRepo.findOne.mockResolvedValue({
        userId,
        stripeAccountId: 'acct_123',
        stripeOnboardingComplete: true, // already done
      });

      const result = await service.handleOnboardingReturn(userId);

      expect(result.data.verified).toBe(true);
      expect(profileRepo.save).not.toHaveBeenCalled();
    });
  });

  // ─── handleAccountUpdated ─────────────────────────────────────────

  describe('handleAccountUpdated', () => {
    it('should update profile when account becomes fully verified', async () => {
      (service as any).stripe = {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
          }),
        },
      };
      profileRepo.findOne.mockResolvedValue({
        stripeAccountId: 'acct_123',
        stripeOnboardingComplete: false,
      });

      await service.handleAccountUpdated('acct_123');

      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ stripeOnboardingComplete: true }),
      );
    });

    it('should do nothing for unknown account', async () => {
      (service as any).stripe = {
        accounts: { retrieve: jest.fn() },
      };
      profileRepo.findOne.mockResolvedValue(null);

      await service.handleAccountUpdated('acct_unknown');

      expect(profileRepo.save).not.toHaveBeenCalled();
    });

    it('should not update if already complete', async () => {
      (service as any).stripe = {
        accounts: {
          retrieve: jest.fn().mockResolvedValue({
            details_submitted: true,
            charges_enabled: true,
            payouts_enabled: true,
          }),
        },
      };
      profileRepo.findOne.mockResolvedValue({
        stripeAccountId: 'acct_123',
        stripeOnboardingComplete: true,
      });

      await service.handleAccountUpdated('acct_123');

      expect(profileRepo.save).not.toHaveBeenCalled();
    });
  });
});
