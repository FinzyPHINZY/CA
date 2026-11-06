/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Availability,
  CalendarEncryptionService,
  CalendarProvider,
  JwtAuthGuard,
  ReaderCalendarConnection,
  ReaderProfile,
  TimeSlot,
  TimeSlotStatus,
} from '@app/common';
import {
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Query,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GoogleCalendarService } from './google-calendar.service';
import { MicrosoftCalendarService } from './microsoft-calendar.service';

type OAuthReturnTo = 'onboarding' | 'settings';

interface OAuthState {
  profileId: string;
  returnTo: OAuthReturnTo;
}

@ApiTags('Calendar')
@Controller('readers/calendar')
export class CalendarOAuthController {
  private readonly logger = new Logger(CalendarOAuthController.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly microsoftCalendarService: MicrosoftCalendarService,
    private readonly encryptionService: CalendarEncryptionService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Google OAuth ───────────────────────────────────────────────────────────

  @Get('google/connect')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get Google Calendar OAuth authorization URL',
    description:
      'Returns the Google OAuth consent URL. Redirect the user to `authUrl` in the same tab ' +
      '(do not use a popup — Google blocks third-party OAuth popups). ' +
      'Pass `returnTo=onboarding` when called from the reader onboarding flow so the callback ' +
      'redirects back to the onboarding step instead of the settings page.',
  })
  @ApiQuery({
    name: 'returnTo',
    required: false,
    enum: ['onboarding', 'settings'],
    description:
      'Where to redirect after OAuth completes. Defaults to `settings`.',
    example: 'onboarding',
  })
  @ApiResponse({
    status: 200,
    description: 'Authorization URL generated successfully.',
    schema: {
      example: {
        success: true,
        data: {
          authUrl:
            'https://accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=...&state=...',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  @ApiResponse({
    status: 404,
    description: 'Reader profile not found for this user.',
  })
  async googleConnect(
    @Req() req: any,
    @Query('returnTo') returnTo: OAuthReturnTo = 'settings',
  ) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId: req.user.id },
    });
    if (!profile) throw new NotFoundException('Reader profile not found');

    const state = this.encodeState({ profileId: profile.id, returnTo });
    const authUrl = this.googleCalendarService.getAuthUrl(state);
    return { success: true, data: { authUrl } };
  }

  @Get('google/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Google Calendar OAuth callback',
    description:
      '**Do not call this endpoint directly from the frontend.** ' +
      'Google redirects the browser here after the user grants or denies consent. ' +
      'The backend exchanges the authorization code for tokens, saves the calendar connection, ' +
      'then redirects the browser to the frontend with `?connected=google` on success ' +
      'or `?error=google_oauth_denied` / `?error=google_oauth_failed` on failure. ' +
      'The redirect destination is `/onboarding/calendar` or `/profile/settings/calendar` depending on `returnTo` in the state.',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    description: 'Authorization code from Google.',
  })
  @ApiQuery({
    name: 'state',
    required: true,
    description: 'Base64url-encoded state carrying profileId and returnTo.',
  })
  @ApiQuery({
    name: 'error',
    required: false,
    description: 'Set by Google if the user denied consent.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirects to frontend with ?connected=google or ?error=...',
  })
  async googleCallback(
    @Query('code') code: string,
    @Query('state') rawState: string,
    @Query('error') error?: string,
  ) {
    const frontendBase = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:5173',
    );
    const { profileId: readerProfileId, returnTo } = this.decodeState(rawState);

    if (error || !code) {
      this.logger.warn(
        `Google OAuth error for profile ${readerProfileId}: ${error}`,
      );
      return {
        url: this.errorUrl(frontendBase, returnTo, 'google_oauth_denied'),
      };
    }

    try {
      const tokens = await this.googleCalendarService.exchangeCode(code);
      const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);

      const existing = await connRepo.findOne({
        where: { readerProfileId, provider: CalendarProvider.GOOGLE },
      });

      const encryptedAccess = this.encryptionService.encrypt(
        tokens.accessToken,
      );
      const encryptedRefresh = tokens.refreshToken
        ? this.encryptionService.encrypt(tokens.refreshToken)
        : existing?.refreshTokenEncrypted;

      const connectedEmail = await this.googleCalendarService.getEmail(
        tokens.accessToken,
      );

      if (existing) {
        await connRepo.update(existing.id, {
          accessTokenEncrypted: encryptedAccess,
          refreshTokenEncrypted: encryptedRefresh,
          tokenExpiresAt: tokens.expiresAt,
          scope: tokens.scope,
          syncEnabled: true,
          connectedEmail,
          lastErrorAt: undefined,
          lastErrorMessage: undefined,
        });
        this.logger.log(
          `Google Calendar connection updated for profile ${readerProfileId}`,
        );
      } else {
        await connRepo.save(
          connRepo.create({
            readerProfileId,
            provider: CalendarProvider.GOOGLE,
            externalCalendarId: 'primary',
            accessTokenEncrypted: encryptedAccess,
            refreshTokenEncrypted: encryptedRefresh,
            tokenExpiresAt: tokens.expiresAt,
            scope: tokens.scope,
            syncEnabled: true,
            connectedEmail,
          }),
        );
        this.logger.log(
          `Google Calendar connection created for profile ${readerProfileId}`,
        );
      }

      return { url: this.successUrl(frontendBase, returnTo, 'google') };
    } catch (err: any) {
      this.logger.error(
        `Google OAuth callback failed: ${err.message}`,
        err.stack,
      );
      return {
        url: this.errorUrl(frontendBase, returnTo, 'google_oauth_failed'),
      };
    }
  }

  // ─── Microsoft Outlook OAuth ─────────────────────────────────────────────────

  @Get('outlook/connect')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get Microsoft Outlook Calendar OAuth authorization URL',
    description:
      'Returns the Microsoft OAuth consent URL. Redirect the user to `authUrl` in the same tab ' +
      '(do not use a popup — Microsoft blocks third-party OAuth popups). ' +
      'Pass `returnTo=onboarding` when called from the reader onboarding flow so the callback ' +
      'redirects back to the onboarding step instead of the settings page.',
  })
  @ApiQuery({
    name: 'returnTo',
    required: false,
    enum: ['onboarding', 'settings'],
    description:
      'Where to redirect after OAuth completes. Defaults to `settings`.',
    example: 'onboarding',
  })
  @ApiResponse({
    status: 200,
    description: 'Authorization URL generated successfully.',
    schema: {
      example: {
        success: true,
        data: {
          authUrl:
            'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=...&scope=...&state=...',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  @ApiResponse({
    status: 404,
    description: 'Reader profile not found for this user.',
  })
  async outlookConnect(
    @Req() req: any,
    @Query('returnTo') returnTo: OAuthReturnTo = 'settings',
  ) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId: req.user.id },
    });
    if (!profile) throw new NotFoundException('Reader profile not found');

    const state = this.encodeState({ profileId: profile.id, returnTo });
    const authUrl = this.microsoftCalendarService.getAuthUrl(state);
    return { success: true, data: { authUrl } };
  }

  @Get('outlook/callback')
  @Redirect()
  @ApiOperation({
    summary: 'Microsoft Outlook Calendar OAuth callback',
    description:
      '**Do not call this endpoint directly from the frontend.** ' +
      'Microsoft redirects the browser here after the user grants or denies consent. ' +
      'The backend exchanges the authorization code for tokens, saves the calendar connection, ' +
      'then redirects the browser to the frontend with `?connected=outlook` on success ' +
      'or `?error=outlook_oauth_denied` / `?error=outlook_oauth_failed` on failure. ' +
      'The redirect destination is `/onboarding/calendar` or `/profile/settings/calendar` depending on `returnTo` in the state.',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    description: 'Authorization code from Microsoft.',
  })
  @ApiQuery({
    name: 'state',
    required: true,
    description: 'Base64url-encoded state carrying profileId and returnTo.',
  })
  @ApiQuery({
    name: 'error',
    required: false,
    description: 'Set by Microsoft if the user denied consent.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirects to frontend with ?connected=outlook or ?error=...',
  })
  async outlookCallback(
    @Query('code') code: string,
    @Query('state') rawState: string,
    @Query('error') error?: string,
  ) {
    const frontendBase = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:5173',
    );
    const { profileId: readerProfileId, returnTo } = this.decodeState(rawState);

    if (error || !code) {
      this.logger.warn(
        `Microsoft OAuth error for profile ${readerProfileId}: ${error}`,
      );
      return {
        url: this.errorUrl(frontendBase, returnTo, 'outlook_oauth_denied'),
      };
    }

    try {
      const tokens = await this.microsoftCalendarService.exchangeCode(code);
      const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);

      const existing = await connRepo.findOne({
        where: { readerProfileId, provider: CalendarProvider.OUTLOOK },
      });

      const encryptedAccess = this.encryptionService.encrypt(
        tokens.accessToken,
      );
      const encryptedRefresh = tokens.refreshToken
        ? this.encryptionService.encrypt(tokens.refreshToken)
        : existing?.refreshTokenEncrypted;

      const connectedEmail = await this.microsoftCalendarService.getEmail(
        tokens.accessToken,
      );

      if (existing) {
        await connRepo.update(existing.id, {
          accessTokenEncrypted: encryptedAccess,
          refreshTokenEncrypted: encryptedRefresh,
          tokenExpiresAt: tokens.expiresAt,
          scope: tokens.scope,
          syncEnabled: true,
          connectedEmail,
          lastErrorAt: undefined,
          lastErrorMessage: undefined,
        });
        this.logger.log(
          `Outlook Calendar connection updated for profile ${readerProfileId}`,
        );
      } else {
        await connRepo.save(
          connRepo.create({
            readerProfileId,
            provider: CalendarProvider.OUTLOOK,
            externalCalendarId: 'primary',
            accessTokenEncrypted: encryptedAccess,
            refreshTokenEncrypted: encryptedRefresh,
            tokenExpiresAt: tokens.expiresAt,
            scope: tokens.scope,
            syncEnabled: true,
            connectedEmail,
          }),
        );
        this.logger.log(
          `Outlook Calendar connection created for profile ${readerProfileId}`,
        );
      }

      return { url: this.successUrl(frontendBase, returnTo, 'outlook') };
    } catch (err: any) {
      this.logger.error(
        `Microsoft OAuth callback failed: ${err.message}`,
        err.stack,
      );
      return {
        url: this.errorUrl(frontendBase, returnTo, 'outlook_oauth_failed'),
      };
    }
  }

  // ─── Disconnect ─────────────────────────────────────────────────────────────

  @Delete(':provider/disconnect')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Disconnect a calendar provider',
    description:
      'Removes the OAuth connection for the specified provider and unblocks all time slots ' +
      'that were blocked due to external calendar busy intervals. ' +
      'Confirmed bookings are not affected. If the provider was not connected, the request is a no-op.',
  })
  @ApiParam({
    name: 'provider',
    enum: CalendarProvider,
    description: 'The calendar provider to disconnect (`google` or `outlook`).',
  })
  @ApiResponse({
    status: 200,
    description: 'Provider disconnected and blocked slots restored.',
    schema: {
      example: {
        success: true,
        message: 'google calendar disconnected successfully',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  @ApiResponse({
    status: 404,
    description: 'Reader profile not found for this user.',
  })
  async disconnect(
    @Req() req: any,
    @Param('provider') provider: CalendarProvider,
  ) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId: req.user.id },
    });
    if (!profile) throw new NotFoundException('Reader profile not found');

    const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);
    const connection = await connRepo.findOne({
      where: { readerProfileId: profile.id, provider },
    });

    if (connection) {
      await this.unblockReaderSlots(profile.userId);
      await connRepo.delete(connection.id);
      this.logger.log(
        `Calendar connection ${provider} removed for profile ${profile.id}`,
      );
    }

    return {
      success: true,
      message: `${provider} calendar disconnected successfully`,
    };
  }

  // ─── List connections ───────────────────────────────────────────────────────

  @Get('connections')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'List connected calendar providers',
    description:
      'Returns all calendar providers the reader has connected, with sync status. ' +
      'Tokens are never returned. If `lastErrorAt` is non-null, the last sync attempt failed — ' +
      'prompt the reader to reconnect the affected provider.',
  })
  @ApiResponse({
    status: 200,
    description: 'Connected calendar providers retrieved.',
    schema: {
      example: {
        success: true,
        message: 'Calendar connections retrieved',
        data: [
          {
            provider: 'google',
            syncEnabled: true,
            lastSyncedAt: '2025-03-06T19:00:00.000Z',
            lastErrorAt: null,
            connectedAt: '2025-03-01T10:00:00.000Z',
          },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  @ApiResponse({
    status: 404,
    description: 'Reader profile not found for this user.',
  })
  async listConnections(@Req() req: any) {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({
      where: { userId: req.user.id },
    });
    if (!profile) throw new NotFoundException('Reader profile not found');

    const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);
    const connections = await connRepo.find({
      where: { readerProfileId: profile.id },
    });

    const data = connections.map((c) => ({
      provider: c.provider,
      connectedEmail: c.connectedEmail ?? null,
      syncEnabled: c.syncEnabled,
      lastSyncedAt: c.lastSyncedAt,
      lastErrorAt: c.lastErrorAt,
      connectedAt: c.createdAt,
    }));

    return { success: true, message: 'Calendar connections retrieved', data };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /** Encode OAuth state as base64 JSON so we can carry profileId + returnTo through the OAuth round-trip. */
  private encodeState(state: OAuthState): string {
    return Buffer.from(JSON.stringify(state)).toString('base64url');
  }

  /** Decode state — falls back to treating the raw value as a plain profileId for backwards compat. */
  private decodeState(raw: string): OAuthState {
    try {
      const decoded = JSON.parse(
        Buffer.from(raw, 'base64url').toString('utf8'),
      );
      return {
        profileId: decoded.profileId,
        returnTo: decoded.returnTo ?? 'settings',
      };
    } catch {
      return { profileId: raw, returnTo: 'settings' };
    }
  }

  private successUrl(
    frontendBase: string,
    returnTo: OAuthReturnTo,
    provider: string,
  ): string {
    if (returnTo === 'onboarding') {
      return `${frontendBase}/home?onboarding_step=availability&connected=${provider}`;
    }
    return `${frontendBase}/profile/settings/calendar?connected=${provider}`;
  }

  private errorUrl(
    frontendBase: string,
    returnTo: OAuthReturnTo,
    error: string,
  ): string {
    if (returnTo === 'onboarding') {
      return `${frontendBase}/home?onboarding_step=availability&error=${error}`;
    }
    return `${frontendBase}/profile/settings/calendar?error=${error}`;
  }

  private async unblockReaderSlots(userId: string): Promise<void> {
    const availabilityRepo = this.dataSource.getRepository(Availability);
    const slotRepo = this.dataSource.getRepository(TimeSlot);

    const availability = await availabilityRepo.findOne({ where: { userId } });
    if (!availability) return;

    await slotRepo
      .createQueryBuilder()
      .update()
      .set({ status: TimeSlotStatus.AVAILABLE })
      .where('availabilityId = :availId', { availId: availability.id })
      .andWhere('status = :blocked', { blocked: TimeSlotStatus.BLOCKED })
      .execute();
  }
}
