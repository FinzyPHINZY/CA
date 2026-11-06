/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { StartOnboardingDto } from './dto/start-onboarding.dto';
import {
  ReaderProfileMeResponseDto,
  ReaderWorkSamplesUpdatedResponseDto,
} from './dto/reader-profile-response.dto';
import { UpdateProfileBasicsDto } from './dto/update-profile-basics.dto';
import { UpdateSessionRatesDto } from './dto/update-session-rates.dto';
import { UpdateSocialLinksDto } from './dto/update-social-links.dto';
import { UpdateSpecialtiesDto } from './dto/update-specialties.dto';
import { UpdateWorkSamplesDto } from './dto/update-work-samples.dto';
import { ReaderProfileService } from './reader-profile.service';
import { StripeConnectService } from './stripe-connect.service';

@ApiTags('Readers')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('readers')
export class ReaderProfileController {
  constructor(
    private readonly readerProfileService: ReaderProfileService,
    private readonly stripeConnectService: StripeConnectService,
  ) {}

  // Onboarding Flow

  @Post('onboard/start')
  @ApiOperation({ summary: 'Start reader onboarding flow' })
  @ApiConflictResponse({
    description: 'User already has a reader profile',
    schema: {
      example: {
        success: false,
        message: 'User already has a reader profile',
        statusCode: 409,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async startOnboarding(@Req() req: any, @Body() dto: StartOnboardingDto) {
    return this.readerProfileService.startOnboarding(req.user.id, dto);
  }

  @Patch('onboard/profile')
  @ApiOperation({ summary: 'Update profile basics (bio, headline, website)' })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error',
    schema: {
      example: { success: false, message: 'Validation error', statusCode: 400 },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateProfileBasics(
    @Req() req: any,
    @Body() dto: UpdateProfileBasicsDto,
  ) {
    return this.readerProfileService.updateProfileBasics(req.user.id, dto);
  }

  @Patch('onboard/specialties')
  @ApiOperation({ summary: 'Update reader specialties/genres' })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error — at least 1 genre required',
    schema: {
      example: {
        success: false,
        message: 'At least 1 genre is required',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateSpecialties(@Req() req: any, @Body() dto: UpdateSpecialtiesDto) {
    return this.readerProfileService.updateSpecialties(req.user.id, dto);
  }

  @Patch('onboard/work-samples')
  @ApiOperation({
    summary: 'Update work samples / reels',
    description:
      'Replaces the reader work samples list. Each sample must use exactly one source: uploaded media via `mediaId` or an external URL via `url`.',
  })
  @ApiBody({
    type: UpdateWorkSamplesDto,
    description:
      'Mixed-source work samples payload. Uploaded samples use `sourceType=upload` + `mediaId`; external samples use `sourceType=external_link` + `url`.',
    schema: {
      example: {
        samples: [
          {
            title: 'Commercial Reel 2026',
            sourceType: 'upload',
            mediaId: '123e4567-e89b-12d3-a456-426614174000',
            thumbnailUrl: 'https://cdn.example.com/thumbnails/reel-2026.jpg',
            type: 'video',
          },
          {
            title: 'Character Demo Playlist',
            sourceType: 'external_link',
            url: 'https://www.youtube.com/watch?v=abc123',
            thumbnailUrl: 'https://img.youtube.com/vi/abc123/hqdefault.jpg',
            type: 'video',
          },
        ],
      },
    },
  })
  @ApiOkResponse({
    description: 'Work samples updated successfully',
    type: ReaderWorkSamplesUpdatedResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation error — at least 1 work sample required, each item must use exactly one source, uploaded samples must reference owned media, and media type must match the declared work sample type.',
    schema: {
      example: {
        success: false,
        message: 'At least 1 work sample is required',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateWorkSamples(@Req() req: any, @Body() dto: UpdateWorkSamplesDto) {
    return this.readerProfileService.updateWorkSamples(req.user.id, dto);
  }

  @Patch('onboard/session-rates')
  @ApiOperation({ summary: 'Update session rates (duration + price pairs)' })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Validation error — at least 1 rate required, priceCents 100-100000',
    schema: {
      example: {
        success: false,
        message: 'At least 1 rate is required',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateSessionRates(
    @Req() req: any,
    @Body() dto: UpdateSessionRatesDto,
  ) {
    return this.readerProfileService.updateSessionRates(req.user.id, dto);
  }

  @Patch('onboard/social-links')
  @ApiOperation({ summary: 'Update social media links' })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error',
    schema: {
      example: { success: false, message: 'Validation error', statusCode: 400 },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateSocialLinks(@Req() req: any, @Body() dto: UpdateSocialLinksDto) {
    return this.readerProfileService.updateSocialLinks(req.user.id, dto);
  }

  @Get('onboard/status')
  @ApiOperation({
    summary: 'Get current onboarding status and step completion',
  })
  @ApiNotFoundResponse({
    description: 'Reader profile not found — user has not started onboarding',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async getOnboardingStatus(@Req() req: any) {
    return this.readerProfileService.getOnboardingStatus(req.user.id);
  }

  // stripe connect

  @Post('onboard/stripe-connect')
  @ApiOperation({
    summary: 'Create Stripe Connect Express account and get onboarding link',
  })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Stripe is not configured or account already exists',
    schema: {
      example: {
        success: false,
        message: 'Stripe is not configured',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async createStripeConnect(@Req() req: any) {
    return this.stripeConnectService.createConnectAccount(req.user.id);
  }

  @Get('onboard/stripe-connect/refresh')
  @ApiOperation({
    summary: 'Get a fresh Stripe onboarding link (if previous expired)',
  })
  @ApiNotFoundResponse({
    description: 'No Stripe account found for this reader',
    schema: {
      example: {
        success: false,
        message: 'No Stripe account found for this reader',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Stripe is not configured',
    schema: {
      example: {
        success: false,
        message: 'Stripe is not configured',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async refreshStripeConnect(@Req() req: any) {
    return this.stripeConnectService.refreshOnboardingLink(req.user.id);
  }

  @Get('onboard/stripe-connect/return')
  @ApiOperation({ summary: 'Handle return from Stripe onboarding redirect' })
  @ApiNotFoundResponse({
    description: 'Reader profile or Stripe account not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile or Stripe account not found',
        statusCode: 404,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async handleStripeReturn(@Req() req: any) {
    return this.stripeConnectService.handleOnboardingReturn(req.user.id);
  }

  // post-onboarding profile

  @Get('profile/me')
  @ApiOperation({ summary: 'Get own reader profile with all related data' })
  @ApiOkResponse({
    description:
      'Full internal reader profile. Work samples include `sourceType` and `mediaId` for uploaded samples.',
    type: ReaderProfileMeResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Reader profile not found' })
  async getMyProfile(@Req() req: any) {
    return this.readerProfileService.getMyProfile(req.user.id);
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update reader profile (post-onboarding edits)' })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation error',
    schema: {
      example: { success: false, message: 'Validation error', statusCode: 400 },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateProfile(@Req() req: any, @Body() dto: UpdateProfileBasicsDto) {
    return this.readerProfileService.updateProfile(req.user.id, dto);
  }

  @Patch('profile/accepting-bookings')
  @ApiOperation({
    summary: 'Toggle accepting bookings on/off',
    description:
      'Enables or disables the reader in search results. ' +
      'Setting to `true` requires onboarding to be completed and at least one session rate to exist.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['accepting'],
      properties: {
        accepting: { type: 'boolean', example: true },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Reader profile not found' })
  @ApiBadRequestResponse({
    description: 'Onboarding not complete or no session rates set',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async setAcceptingBookings(
    @Req() req: any,
    @Body('accepting') accepting: boolean,
  ) {
    return this.readerProfileService.setAcceptingBookings(
      req.user.id,
      accepting,
    );
  }
}
