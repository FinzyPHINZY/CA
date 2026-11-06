/** biome-ignore-all lint/style/useImportType: <> */
import {
  OnboardingStatus,
  OnboardingStep,
  ReaderProfile,
  User,
} from '@app/common';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { DataSource, type EntityManager } from 'typeorm';

@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-11-17.clover',
      });
    }
  }

  private ensureStripe(): Stripe {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }
    return this.stripe;
  }

  // create a Stripe Connect Express account and return the onboarding link.
  async createConnectAccount(userId: string) {
    const stripe = this.ensureStripe();

    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const userRepo = manager.getRepository(User);

        const profile = await profileRepo.findOne({ where: { userId } });
        if (!profile) {
          throw new NotFoundException('Reader profile not found');
        }

        // if already has a Stripe account, just generate a new link
        if (profile.stripeAccountId) {
          const link = await this.generateOnboardingLink(
            stripe,
            profile.stripeAccountId,
          );
          return { url: link.url };
        }

        // get user email for the account
        const user = await userRepo.findOne({ where: { id: userId } });
        if (!user?.email) {
          throw new BadRequestException(
            'User email is required for Stripe Connect',
          );
        }

        // create Express account
        const account = await stripe.accounts.create({
          type: 'express',
          email: user.email,
          metadata: {
            userId,
            readerProfileId: profile.id,
          },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        });

        // save account ID
        profile.stripeAccountId = account.id;
        await profileRepo.save(profile);

        this.logger.log(
          `Created Stripe Connect account ${account.id} for user ${userId}`,
        );

        // generate onboarding link
        const link = await this.generateOnboardingLink(stripe, account.id);
        return { url: link.url };
      },
    );

    return {
      success: true,
      message: 'Stripe Connect account created successfully',
      data: result,
    };
  }

  // generate a fresh Stripe onboarding link (for expired/dropped-off sessions).
  async refreshOnboardingLink(userId: string) {
    const stripe = this.ensureStripe();

    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({ where: { userId } });

    if (!profile?.stripeAccountId) {
      throw new NotFoundException(
        'No Stripe account found. Start Stripe onboarding first.',
      );
    }

    const link = await this.generateOnboardingLink(
      stripe,
      profile.stripeAccountId,
    );
    return {
      success: true,
      message: 'Onboarding link refreshed successfully',
      data: { url: link.url },
    };
  }

  // handle return from Stripe onboarding redirect. check account status and update profile.
  async handleOnboardingReturn(userId: string) {
    const stripe = this.ensureStripe();

    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const profile = await profileRepo.findOne({ where: { userId } });

        if (!profile?.stripeAccountId) {
          throw new NotFoundException('No Stripe account found');
        }

        const account = await stripe.accounts.retrieve(profile.stripeAccountId);

        const verified =
          account.details_submitted &&
          account.charges_enabled &&
          account.payouts_enabled;

        if (verified && !profile.stripeOnboardingComplete) {
          profile.stripeOnboardingComplete = true;
          profile.onboardingStep = OnboardingStep.COMPLETED;
          profile.onboardingStatus = OnboardingStatus.COMPLETED;

          // auto-enable bookings if profile is otherwise complete
          const hasSpecialties = await manager
            .getRepository('ReaderSpecialty')
            .count({ where: { readerProfileId: profile.id } });
          const hasRates = await manager
            .getRepository('ReaderSessionRate')
            .count({ where: { readerProfileId: profile.id } });

          if (
            (profile.bio || profile.headline) &&
            hasSpecialties > 0 &&
            hasRates > 0
          ) {
            profile.isAcceptingBookings = true;
          }

          await profileRepo.save(profile);
          this.logger.log(
            `Stripe Connect onboarding completed for user ${userId}`,
          );
        }

        return {
          verified: !!verified,
          detailsSubmitted: !!account.details_submitted,
          chargesEnabled: !!account.charges_enabled,
          payoutsEnabled: !!account.payouts_enabled,
        };
      },
    );

    return {
      success: true,
      message: 'Stripe onboarding status retrieved successfully',
      data: result,
    };
  }

  // handle account.updated webhook from Stripe. called when KYC status changes.
  async handleAccountUpdated(accountId: string): Promise<void> {
    const stripe = this.ensureStripe();

    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { stripeAccountId: accountId },
    });

    if (!profile) {
      this.logger.warn(
        `Received account.updated for unknown Stripe account ${accountId}`,
      );
      return;
    }

    const account = await stripe.accounts.retrieve(accountId);
    const wasComplete = profile.stripeOnboardingComplete;
    const isNowComplete =
      account.details_submitted &&
      account.charges_enabled &&
      account.payouts_enabled;

    if (isNowComplete && !wasComplete) {
      profile.stripeOnboardingComplete = true;
      await profileRepo.save(profile);
      this.logger.log(
        `Stripe Connect verification completed via webhook for account ${accountId}`,
      );

      // auto-complete onboarding if all other steps are done
      const fullProfile = await profileRepo.findOne({
        where: { id: profile.id },
        relations: [
          'sessionRates',
          'specialties',
          'workSamples',
          'socialLinks',
        ],
      });
      if (
        fullProfile &&
        fullProfile.onboardingStatus !== OnboardingStatus.COMPLETED &&
        Boolean(
          fullProfile.bio || fullProfile.headline || fullProfile.websiteUrl,
        ) &&
        (fullProfile.specialties?.length ?? 0) > 0 &&
        (fullProfile.workSamples?.length ?? 0) > 0 &&
        (fullProfile.sessionRates?.length ?? 0) > 0
      ) {
        fullProfile.onboardingStatus = OnboardingStatus.COMPLETED;
        fullProfile.onboardingStep = OnboardingStep.COMPLETED;
        fullProfile.isAcceptingBookings =
          (fullProfile.sessionRates?.length ?? 0) > 0;
        await profileRepo.save(fullProfile);
        this.logger.log(
          `Reader onboarding auto-completed via webhook for account ${accountId}`,
        );
      }
    }
  }

  private async generateOnboardingLink(
    stripe: Stripe,
    accountId: string,
  ): Promise<Stripe.AccountLink> {
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:5173',
    );

    return stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${frontendUrl}/home?onboarding_step=stripe_refresh`,
      return_url: `${frontendUrl}/home?onboarding_step=payment_setup&verification=true`,
      type: 'account_onboarding',
    });
  }
}
