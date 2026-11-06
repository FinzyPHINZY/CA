/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { ReaderProfileController } from './reader-profile.controller';
import { ReaderProfileService } from './reader-profile.service';
import { StripeConnectService } from './stripe-connect.service';

describe('ReaderProfileController', () => {
  let controller: ReaderProfileController;
  let profileService: jest.Mocked<Partial<ReaderProfileService>>;
  let stripeService: jest.Mocked<Partial<StripeConnectService>>;

  const mockReq = { user: { id: 'user-1' } };

  beforeEach(() => {
    profileService = {
      startOnboarding: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateProfileBasics: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateSpecialties: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateWorkSamples: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateSessionRates: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateSocialLinks: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      getOnboardingStatus: jest.fn().mockResolvedValue({ hasProfile: false }),
      getMyProfile: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      updateProfile: jest.fn().mockResolvedValue({ id: 'profile-1' }),
    };

    stripeService = {
      createConnectAccount: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { url: 'https://stripe.com/onboard' },
      }),
      refreshOnboardingLink: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { url: 'https://stripe.com/refresh' },
      }),
      handleOnboardingReturn: jest.fn().mockResolvedValue({
        success: true,
        message: 'OK',
        data: { verified: true },
      }),
    };

    controller = new ReaderProfileController(
      profileService as unknown as ReaderProfileService,
      stripeService as unknown as StripeConnectService,
    );
  });

  // ─── Onboarding Flow ─────────────────────────────────────────────

  describe('startOnboarding', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = { timezone: 'America/New_York' };
      await controller.startOnboarding(mockReq, dto as any);

      expect(profileService.startOnboarding).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('updateProfileBasics', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = { bio: 'My bio', headline: 'Great reader' };
      await controller.updateProfileBasics(mockReq, dto as any);

      expect(profileService.updateProfileBasics).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('updateSpecialties', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = { genres: ['Drama', 'Comedy'] };
      await controller.updateSpecialties(mockReq, dto as any);

      expect(profileService.updateSpecialties).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('updateWorkSamples', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = {
        samples: [
          {
            title: 'Reel',
            sourceType: 'external_link',
            url: 'https://example.com',
            type: 'video',
          },
        ],
      };
      await controller.updateWorkSamples(mockReq, dto as any);

      expect(profileService.updateWorkSamples).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('updateSessionRates', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = { rates: [{ durationMinutes: 30, priceCents: 5000 }] };
      await controller.updateSessionRates(mockReq, dto as any);

      expect(profileService.updateSessionRates).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('updateSocialLinks', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = {
        links: [{ platform: 'instagram', url: 'https://ig.com/user' }],
      };
      await controller.updateSocialLinks(mockReq, dto as any);

      expect(profileService.updateSocialLinks).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('getOnboardingStatus', () => {
    it('should delegate with userId', async () => {
      await controller.getOnboardingStatus(mockReq);

      expect(profileService.getOnboardingStatus).toHaveBeenCalledWith('user-1');
    });
  });

  // ─── Stripe Connect ──────────────────────────────────────────────

  describe('createStripeConnect', () => {
    it('should delegate to stripeConnectService', async () => {
      const result = await controller.createStripeConnect(mockReq);

      expect(stripeService.createConnectAccount).toHaveBeenCalledWith('user-1');
      expect(result.data.url).toContain('stripe.com');
    });
  });

  describe('refreshStripeConnect', () => {
    it('should delegate to stripeConnectService', async () => {
      await controller.refreshStripeConnect(mockReq);

      expect(stripeService.refreshOnboardingLink).toHaveBeenCalledWith(
        'user-1',
      );
    });
  });

  describe('handleStripeReturn', () => {
    it('should delegate to stripeConnectService', async () => {
      const result = await controller.handleStripeReturn(mockReq);

      expect(stripeService.handleOnboardingReturn).toHaveBeenCalledWith(
        'user-1',
      );
      expect(result.data.verified).toBe(true);
    });
  });

  // ─── Post-onboarding Profile ──────────────────────────────────────

  describe('getMyProfile', () => {
    it('should delegate with userId', async () => {
      await controller.getMyProfile(mockReq);

      expect(profileService.getMyProfile).toHaveBeenCalledWith('user-1');
    });
  });

  describe('updateProfile', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = { bio: 'Updated bio' };
      await controller.updateProfile(mockReq, dto as any);

      expect(profileService.updateProfile).toHaveBeenCalledWith('user-1', dto);
    });
  });
});
