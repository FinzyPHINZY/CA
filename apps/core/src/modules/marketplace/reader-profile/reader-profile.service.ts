/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Media,
  MediaType,
  OnboardingStatus,
  OnboardingStep,
  ReaderWorkSampleSourceType,
  ReaderProfile,
  ReaderSessionRate,
  ReaderSocialLink,
  ReaderSpecialty,
  ReaderWorkSample,
  User,
  UserRoleEntity,
  UserRole,
  WorkSampleType,
} from '@app/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StartOnboardingDto } from './dto/start-onboarding.dto';
import { UpdateProfileBasicsDto } from './dto/update-profile-basics.dto';
import { UpdateSessionRatesDto } from './dto/update-session-rates.dto';
import { UpdateSocialLinksDto } from './dto/update-social-links.dto';
import { UpdateSpecialtiesDto } from './dto/update-specialties.dto';
import { UpdateWorkSamplesDto } from './dto/update-work-samples.dto';

@Injectable()
export class ReaderProfileService {
  private readonly logger = new Logger(ReaderProfileService.name);

  constructor(private readonly dataSource: DataSource) {}

  // create a ReaderProfile and sets user's role to 'reader'.
  async startOnboarding(userId: string, dto: StartOnboardingDto) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const userRepo = manager.getRepository(User);

        // check if profile already exists
        const existing = await profileRepo.findOne({ where: { userId } });
        if (existing) {
          throw new ConflictException(
            'Reader profile already exists. Use GET /api/readers/onboard/status to check your onboarding progress.',
          );
        }

        // create reader profile
        const profile = profileRepo.create({
          userId,
          onboardingStatus: OnboardingStatus.IN_PROGRESS,
          onboardingStep: OnboardingStep.BIO,
        });
        const savedProfile = await profileRepo.save(profile);

        // set user's role to reader if not already set
        const user = await userRepo.findOne({ where: { id: userId } });
        if (user && user.role?.code !== UserRole.READER) {
          const readerRole = await manager
            .getRepository(UserRoleEntity)
            .findOne({ where: { code: UserRole.READER } });
          if (!readerRole) {
            throw new BadRequestException('Reader role is not configured');
          }
          user.roleId = readerRole.id;
          user.role = readerRole;
          if (dto.timezone) {
            user.timezone = dto.timezone;
          }
          await userRepo.save(user);
        }

        this.logger.log(`Reader onboarding started for user ${userId}`);
        return savedProfile;
      },
    );

    return {
      success: true,
      message: 'Reader onboarding started successfully',
      data: result,
    };
  }

  // update profile basics (bio, headline, website) and advances onboarding step to 'specialties'.
  async updateProfileBasics(userId: string, dto: UpdateProfileBasicsDto) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const profile = await this.getProfileOrFail(profileRepo, userId);

        if (dto.bio !== undefined) profile.bio = dto.bio;
        if (dto.headline !== undefined) profile.headline = dto.headline;
        if (dto.websiteUrl !== undefined) profile.websiteUrl = dto.websiteUrl;
        if (dto.yearsOfExperience !== undefined)
          profile.yearsOfExperience = dto.yearsOfExperience;
        if (profile.onboardingStep === OnboardingStep.BIO) {
          profile.onboardingStep = OnboardingStep.SPECIALTIES;
        }

        return profileRepo.save(profile);
      },
    );

    await this.tryAutoCompleteOnboarding(userId);

    return {
      success: true,
      message: 'Profile basics updated successfully',
      data: result,
    };
  }

  async updateSpecialties(userId: string, dto: UpdateSpecialtiesDto) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const specialtyRepo = manager.getRepository(ReaderSpecialty);
        const profile = await this.getProfileOrFail(profileRepo, userId);

        // remove existing specialties
        await specialtyRepo.delete({ readerProfileId: profile.id });

        // create new specialties (deduplicated)
        const uniqueGenres = [
          ...new Set(dto.genres.map((g) => g.trim()).filter(Boolean)),
        ];
        const specialties = uniqueGenres.map((genre) =>
          specialtyRepo.create({ readerProfileId: profile.id, genre }),
        );
        await specialtyRepo.save(specialties);

        // advance step
        if (profile.onboardingStep === OnboardingStep.SPECIALTIES) {
          profile.onboardingStep = OnboardingStep.WORK_SAMPLES;
        }
        return profileRepo.save(profile);
      },
    );

    await this.tryAutoCompleteOnboarding(userId);

    return {
      success: true,
      message: 'Specialties updated successfully',
      data: result,
    };
  }

  // update work samples / reels and advances onboarding step to 'session_rates'.
  async updateWorkSamples(userId: string, dto: UpdateWorkSamplesDto) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const sampleRepo = manager.getRepository(ReaderWorkSample);
        const mediaRepo = manager.getRepository(Media);
        const profile = await this.getProfileOrFail(profileRepo, userId);

        // remove existing samples
        await sampleRepo.delete({ readerProfileId: profile.id });

        const samples = [];
        for (const sample of dto.samples) {
          if (sample.sourceType === ReaderWorkSampleSourceType.UPLOAD) {
            if (!sample.mediaId || sample.url) {
              throw new BadRequestException(
                'Uploaded work samples must provide mediaId and must not provide url',
              );
            }

            const media = await mediaRepo.findOne({
              where: { id: sample.mediaId, userId },
            });
            if (!media) {
              throw new NotFoundException(
                `Uploaded work sample media ${sample.mediaId} not found`,
              );
            }

            if (![MediaType.VIDEO, MediaType.AUDIO].includes(media.type)) {
              throw new BadRequestException(
                `Media ${sample.mediaId} is not a valid reader work sample asset`,
              );
            }

            if (
              (sample.type === WorkSampleType.VIDEO &&
                media.type !== MediaType.VIDEO) ||
              (sample.type === WorkSampleType.AUDIO &&
                media.type !== MediaType.AUDIO)
            ) {
              throw new BadRequestException(
                `Work sample type "${sample.type}" does not match uploaded media type "${media.type}"`,
              );
            }

            samples.push(
              sampleRepo.create({
                readerProfileId: profile.id,
                title: sample.title,
                url: media.url,
                thumbnailUrl: sample.thumbnailUrl ?? null,
                type: sample.type,
                sourceType: ReaderWorkSampleSourceType.UPLOAD,
                mediaId: media.id,
              }),
            );
            continue;
          }

          if (sample.sourceType === ReaderWorkSampleSourceType.EXTERNAL_LINK) {
            if (!sample.url || sample.mediaId) {
              throw new BadRequestException(
                'External-link work samples must provide url and must not provide mediaId',
              );
            }

            samples.push(
              sampleRepo.create({
                readerProfileId: profile.id,
                title: sample.title,
                url: sample.url,
                thumbnailUrl: sample.thumbnailUrl ?? null,
                type: sample.type,
                sourceType: ReaderWorkSampleSourceType.EXTERNAL_LINK,
                mediaId: null,
              }),
            );
            continue;
          }

          throw new BadRequestException(
            `Unsupported work sample source type "${sample.sourceType}"`,
          );
        }

        await sampleRepo.save(samples);

        // advance step
        if (profile.onboardingStep === OnboardingStep.WORK_SAMPLES) {
          profile.onboardingStep = OnboardingStep.SESSION_RATES;
        }
        return profileRepo.save(profile);
      },
    );

    await this.tryAutoCompleteOnboarding(userId);

    return {
      success: true,
      message: 'Work samples updated successfully',
      data: result,
    };
  }

  // update session rates (duration + price pairs) and advances onboarding step to 'social_links'.
  async updateSessionRates(userId: string, dto: UpdateSessionRatesDto) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const rateRepo = manager.getRepository(ReaderSessionRate);
        const profile = await this.getProfileOrFail(profileRepo, userId);

        // remove existing rates
        await rateRepo.delete({ readerProfileId: profile.id });

        // create new rates
        const rates = dto.rates.map((r) =>
          rateRepo.create({
            readerProfileId: profile.id,
            durationMinutes: r.durationMinutes,
            priceCents: r.priceCents,
            currency: r.currency || 'USD',
          }),
        );
        await rateRepo.save(rates);

        // advance step
        if (profile.onboardingStep === OnboardingStep.SESSION_RATES) {
          profile.onboardingStep = OnboardingStep.PAYMENT_SETUP;
        }
        return profileRepo.save(profile);
      },
    );

    await this.tryAutoCompleteOnboarding(userId);

    return {
      success: true,
      message: 'Session rates updated successfully',
      data: result,
    };
  }

  // update social links. social_links is not an onboarding wizard step.
  async updateSocialLinks(userId: string, dto: UpdateSocialLinksDto) {
    // validate no duplicate platforms in the request
    if (dto.links && dto.links.length > 0) {
      const platforms = dto.links.map((l) => l.platform);
      const unique = new Set(platforms);
      if (unique.size !== platforms.length) {
        const dupes = platforms.filter((p, i) => platforms.indexOf(p) !== i);
        throw new BadRequestException(
          `Duplicate platforms not allowed: ${[...new Set(dupes)].join(', ')}`,
        );
      }
    }

    try {
      const result = await this.dataSource.transaction(
        async (manager: EntityManager) => {
          const profileRepo = manager.getRepository(ReaderProfile);
          const linkRepo = manager.getRepository(ReaderSocialLink);
          const profile = await this.getProfileOrFail(profileRepo, userId);

          // remove existing links
          await linkRepo.delete({ readerProfileId: profile.id });

          // create new links (if provided)
          if (dto.links && dto.links.length > 0) {
            const links = dto.links.map((l) =>
              linkRepo.create({
                readerProfileId: profile.id,
                platform: l.platform,
                url: l.url,
              }),
            );
            await linkRepo.save(links);
          }

          return profileRepo.findOne({
            where: { id: profile.id },
            relations: ['socialLinks'],
          });
        },
      );

      await this.tryAutoCompleteOnboarding(userId);

      return {
        success: true,
        message: 'Social links updated successfully',
        data: result,
      };
    } catch (err: any) {
      this.logger.error(`updateSocialLinks error: ${err.message}`, err.stack);
      if (err instanceof BadRequestException) throw err;
      if (err instanceof NotFoundException) throw err;
      // surface DB constraint violations as 400 instead of 500
      if (err.code === '23505') {
        throw new BadRequestException(
          'Duplicate platform entry — each platform can only appear once',
        );
      }
      throw err;
    }
  }

  // get current onboarding status with step completion info.
  async getOnboardingStatus(userId: string) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId },
      relations: ['sessionRates', 'specialties', 'workSamples', 'socialLinks'],
    });

    if (!profile) {
      return {
        success: true,
        message: 'Onboarding status retrieved successfully',
        data: {
          hasProfile: false,
          onboardingStatus: OnboardingStatus.NOT_STARTED,
          onboardingStep: null,
          steps: this.buildStepCompletion(null),
        },
      };
    }

    return {
      success: true,
      message: 'Onboarding status retrieved successfully',
      data: {
        hasProfile: true,
        profileId: profile.id,
        onboardingStatus: profile.onboardingStatus,
        onboardingStep: profile.onboardingStep,
        stripeOnboardingComplete: profile.stripeOnboardingComplete,
        isAcceptingBookings: profile.isAcceptingBookings,
        steps: this.buildStepCompletion(profile),
      },
    };
  }

  // mark onboarding as completed if all requirements are met. called after Stripe Connect onboarding is verified.
  async completeOnboarding(userId: string) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const profile = await profileRepo.findOne({
          where: { userId },
          relations: ['sessionRates', 'specialties'],
        });

        if (!profile) {
          throw new NotFoundException('Reader profile not found');
        }

        const validation = this.validateProfileCompletion(profile);
        if (!validation.isComplete) {
          throw new BadRequestException(
            `Profile is incomplete. Missing: ${validation.missing.join(', ')}`,
          );
        }

        profile.onboardingStatus = OnboardingStatus.COMPLETED;
        profile.onboardingStep = OnboardingStep.COMPLETED;
        // only accept bookings if the reader has at least one session rate set
        profile.isAcceptingBookings = (profile.sessionRates?.length ?? 0) > 0;

        this.logger.log(`Reader onboarding completed for user ${userId}`);
        return profileRepo.save(profile);
      },
    );

    return {
      success: true,
      message: 'Reader onboarding completed successfully',
      data: result,
    };
  }

  // check if all onboarding steps are complete and auto-complete if so.
  async tryAutoCompleteOnboarding(userId: string): Promise<boolean> {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId },
      relations: ['sessionRates', 'specialties', 'workSamples', 'socialLinks'],
    });

    if (!profile || profile.onboardingStatus === OnboardingStatus.COMPLETED) {
      return false;
    }

    const steps = this.buildStepCompletion(profile);
    const allComplete =
      steps.bio &&
      steps.specialties &&
      steps.work_samples &&
      steps.session_rates &&
      steps.payment_setup;

    if (!allComplete) {
      return false;
    }

    profile.onboardingStatus = OnboardingStatus.COMPLETED;
    profile.onboardingStep = OnboardingStep.COMPLETED;
    profile.isAcceptingBookings = (profile.sessionRates?.length ?? 0) > 0;
    await profileRepo.save(profile);

    this.logger.log(`Reader onboarding auto-completed for user ${userId}`);
    return true;
  }

  // toggle isAcceptingBookings. can only be set to true if onboarding is complete and at least one session rate exists.
  async setAcceptingBookings(userId: string, accepting: boolean) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const profile = await profileRepo.findOne({
          where: { userId },
          relations: ['sessionRates'],
        });

        if (!profile) {
          throw new NotFoundException('Reader profile not found');
        }

        if (accepting) {
          if (profile.onboardingStatus !== OnboardingStatus.COMPLETED) {
            throw new BadRequestException(
              'Onboarding must be completed before accepting bookings',
            );
          }
          if ((profile.sessionRates?.length ?? 0) === 0) {
            throw new BadRequestException(
              'At least one session rate is required before accepting bookings',
            );
          }
        }

        profile.isAcceptingBookings = accepting;
        return profileRepo.save(profile);
      },
    );

    return {
      success: true,
      message: `Now ${result.isAcceptingBookings ? 'accepting' : 'not accepting'} bookings`,
      data: { isAcceptingBookings: result.isAcceptingBookings },
    };
  }

  // get own reader profile with all related data.
  async getMyProfile(userId: string) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId },
      relations: [
        'sessionRates',
        'specialties',
        'workSamples',
        'socialLinks',
        'calendarConnections',
      ],
    });

    if (!profile) {
      throw new NotFoundException('Reader profile not found');
    }

    return {
      success: true,
      message: 'Reader profile retrieved successfully',
      data: {
        ...profile,
        workSamples: (profile.workSamples ?? []).map((sample) =>
          this.toInternalWorkSample(sample),
        ),
      },
    };
  }

  // general profile update (post-onboarding edits).
  async updateProfile(userId: string, dto: UpdateProfileBasicsDto) {
    const result = await this.dataSource.transaction(
      async (manager: EntityManager) => {
        const profileRepo = manager.getRepository(ReaderProfile);
        const profile = await this.getProfileOrFail(profileRepo, userId);

        if (dto.bio !== undefined) profile.bio = dto.bio;
        if (dto.headline !== undefined) profile.headline = dto.headline;
        if (dto.websiteUrl !== undefined) profile.websiteUrl = dto.websiteUrl;
        if (dto.yearsOfExperience !== undefined)
          profile.yearsOfExperience = dto.yearsOfExperience;

        return profileRepo.save(profile);
      },
    );

    return {
      success: true,
      message: 'Reader profile updated successfully',
      data: result,
    };
  }

  // private helpers

  private async getProfileOrFail(
    repo: any,
    userId: string,
  ): Promise<ReaderProfile> {
    const profile = await repo.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException(
        'Reader profile not found. Start onboarding first at POST /api/readers/onboard/start',
      );
    }
    return profile;
  }

  private validateProfileCompletion(_profile: ReaderProfile): {
    isComplete: boolean;
    missing: string[];
  } {
    // all onboarding steps are skippable; no fields are required to complete
    return { isComplete: true, missing: [] };
  }

  private buildStepCompletion(profile: ReaderProfile | null) {
    if (!profile) {
      return {
        bio: false,
        specialties: false,
        work_samples: false,
        session_rates: false,
        social_links: false,
        payment_setup: false,
      };
    }

    return {
      bio: Boolean(profile.bio || profile.headline || profile.websiteUrl),
      specialties: (profile.specialties?.length ?? 0) > 0,
      work_samples: (profile.workSamples?.length ?? 0) > 0,
      session_rates: (profile.sessionRates?.length ?? 0) > 0,
      social_links: (profile.socialLinks?.length ?? 0) > 0,
      payment_setup: profile.stripeOnboardingComplete,
    };
  }

  private toInternalWorkSample(sample: ReaderWorkSample) {
    return {
      id: sample.id,
      title: sample.title,
      url: sample.url,
      thumbnailUrl: sample.thumbnailUrl,
      type: sample.type,
      sourceType: sample.sourceType,
      mediaId: sample.mediaId,
      createdAt: sample.createdAt,
      updatedAt: sample.updatedAt,
    };
  }
}
