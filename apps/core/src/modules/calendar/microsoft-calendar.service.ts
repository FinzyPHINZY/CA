/** biome-ignore-all lint/style/useImportType: <> */
import { CalendarEncryptionService } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@microsoft/microsoft-graph-client';

export interface MicrosoftTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
}

// Delegated scopes — user must consent to these
const SCOPES = [
  'Calendars.Read',
  'Calendars.ReadWrite',
  'offline_access',
  'openid',
  'User.Read',
];

@Injectable()
export class MicrosoftCalendarService {
  private readonly logger = new Logger(MicrosoftCalendarService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly encryptionService: CalendarEncryptionService,
  ) {}

  getAuthUrl(statePayload: string): string {
    const tenantId = this.configService.get<string>(
      'MICROSOFT_CALENDAR_TENANT_ID',
      'common',
    );
    const clientId = this.configService.get<string>(
      'MICROSOFT_CALENDAR_CLIENT_ID',
    );
    const redirectUri = this.configService.get<string>(
      'MICROSOFT_CALENDAR_REDIRECT_URI',
    );

    const params = new URLSearchParams({
      client_id: clientId!,
      response_type: 'code',
      redirect_uri: redirectUri!,
      scope: SCOPES.join(' '),
      response_mode: 'query',
      state: statePayload,
      prompt: 'consent', // always ask so we get refresh_token
    });

    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async getEmail(accessToken: string): Promise<string | undefined> {
    try {
      const client = this.buildGraphClient(accessToken);
      const me = await client.api('/me').select('mail,userPrincipalName').get();
      return (me.mail ?? me.userPrincipalName) || undefined;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Microsoft user email: ${err.message}`);
      return undefined;
    }
  }

  async exchangeCode(code: string): Promise<MicrosoftTokens> {
    return this.callTokenEndpoint({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.configService.get<string>(
        'MICROSOFT_CALENDAR_REDIRECT_URI',
      )!,
    });
  }

  async refreshAccessToken(
    refreshTokenEncrypted: string,
  ): Promise<MicrosoftTokens> {
    const refreshToken = this.encryptionService.decrypt(refreshTokenEncrypted);
    return this.callTokenEndpoint({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  /**
   * Fetch busy intervals from the user's Outlook calendar via /me/calendarView.
   * Returns intervals in ISO format, same shape as GoogleBusyInterval.
   */
  async getFreeBusy(
    accessToken: string,
    timeMin: Date,
    timeMax: Date,
  ): Promise<{ start: string; end: string }[]> {
    const client = this.buildGraphClient(accessToken);

    const response = await client
      .api('/me/calendarView')
      .query({
        startDateTime: timeMin.toISOString(),
        endDateTime: timeMax.toISOString(),
        $select: 'start,end,showAs',
        $top: '500',
      })
      .get();

    const events: any[] = response.value ?? [];
    return events
      .filter((e) => e.showAs === 'busy' || e.showAs === 'tentative')
      .map((e) => ({
        start: e.start.dateTime,
        end: e.end.dateTime,
      }));
  }

  /**
   * Create a calendar event for a confirmed booking. Returns the Outlook event ID.
   */
  async createEvent(
    accessToken: string,
    params: {
      summary: string;
      description: string;
      startUtc: Date;
      endUtc: Date;
      bookingId: string;
    },
  ): Promise<string> {
    const client = this.buildGraphClient(accessToken);

    const event = await client.api('/me/events').post({
      subject: params.summary,
      body: { contentType: 'text', content: params.description },
      start: { dateTime: params.startUtc.toISOString(), timeZone: 'UTC' },
      end: { dateTime: params.endUtc.toISOString(), timeZone: 'UTC' },
      // store our booking ID as an extended property for traceability
      singleValueExtendedProperties: [
        {
          id: 'String {00020329-0000-0000-C000-000000000046} Name cueactorBookingId',
          value: params.bookingId,
        },
      ],
    });

    return event.id as string;
  }

  /**
   * Delete an Outlook event (best-effort — swallows 404s).
   */
  async deleteEvent(accessToken: string, eventId: string): Promise<void> {
    try {
      const client = this.buildGraphClient(accessToken);
      await client.api(`/me/events/${eventId}`).delete();
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) return;
      throw err;
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildGraphClient(accessToken: string): Client {
    return Client.init({
      authProvider: (done) => done(null, accessToken),
    });
  }

  private async callTokenEndpoint(
    params: Record<string, string>,
  ): Promise<MicrosoftTokens> {
    const tenantId = this.configService.get<string>(
      'MICROSOFT_CALENDAR_TENANT_ID',
      'common',
    );
    const clientId = this.configService.get<string>(
      'MICROSOFT_CALENDAR_CLIENT_ID',
    )!;
    const clientSecret = this.configService.get<string>(
      'MICROSOFT_CALENDAR_CLIENT_SECRET',
    )!;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPES.join(' '),
      ...params,
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Microsoft token endpoint error: ${response.status} ${text}`,
      );
    }

    const data = (await response.json()) as any;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + (data.expires_in as number) * 1000),
      scope: data.scope ?? SCOPES.join(' '),
    };
  }
}
