/** biome-ignore-all lint/style/useImportType: <> */
import { CalendarEncryptionService } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
}

export interface GoogleBusyInterval {
  start: string;
  end: string;
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly encryptionService: CalendarEncryptionService,
  ) {}

  getAuthUrl(statePayload: string): string {
    const client = this.buildOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent', // force consent screen so we always get a refresh_token
      state: statePayload,
    });
  }

  async getEmail(accessToken: string): Promise<string | undefined> {
    try {
      const client = this.buildOAuthClient();
      client.setCredentials({ access_token: accessToken });
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const { data } = await oauth2.userinfo.get();
      return data.email ?? undefined;
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Google user email: ${err.message}`);
      return undefined;
    }
  }

  async exchangeCode(code: string): Promise<GoogleTokens> {
    const client = this.buildOAuthClient();
    const { tokens } = await client.getToken(code);

    return {
      accessToken: tokens.access_token!,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: new Date(tokens.expiry_date!),
      scope: tokens.scope ?? SCOPES.join(' '),
    };
  }

  async refreshAccessToken(
    refreshTokenEncrypted: string,
  ): Promise<GoogleTokens> {
    const refreshToken = this.encryptionService.decrypt(refreshTokenEncrypted);
    const client = this.buildOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await client.refreshAccessToken();
    return {
      accessToken: credentials.access_token!,
      expiresAt: new Date(credentials.expiry_date!),
      scope: credentials.scope ?? SCOPES.join(' '),
    };
  }

  /**
   * Query Google Calendar freebusy API for a time window.
   * Returns busy intervals for the primary calendar (or the specified calendarId).
   */
  async getFreeBusy(
    accessToken: string,
    calendarId: string,
    timeMin: Date,
    timeMax: Date,
  ): Promise<GoogleBusyInterval[]> {
    const client = this.buildOAuthClient();
    client.setCredentials({ access_token: accessToken });

    const calendar = google.calendar({ version: 'v3', auth: client });
    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: calendarId }],
      },
    });

    const calendars = response.data.calendars ?? {};
    const busy = calendars[calendarId]?.busy ?? [];
    return busy.filter((b) => b.start && b.end) as GoogleBusyInterval[];
  }

  /**
   * Create a calendar event for a confirmed booking.
   * Returns the external event ID for storing on the booking.
   */
  async createEvent(
    accessToken: string,
    calendarId: string,
    params: {
      summary: string;
      description: string;
      startUtc: Date;
      endUtc: Date;
      bookingId: string;
    },
  ): Promise<string> {
    const client = this.buildOAuthClient();
    client.setCredentials({ access_token: accessToken });

    const calendar = google.calendar({ version: 'v3', auth: client });
    const event = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: params.summary,
        description: params.description,
        start: { dateTime: params.startUtc.toISOString(), timeZone: 'UTC' },
        end: { dateTime: params.endUtc.toISOString(), timeZone: 'UTC' },
        extendedProperties: {
          private: { cueactorBookingId: params.bookingId },
        },
      },
    });

    return event.data.id!;
  }

  /**
   * Delete a calendar event (best-effort — swallows 404s).
   */
  async deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
  ): Promise<void> {
    try {
      const client = this.buildOAuthClient();
      client.setCredentials({ access_token: accessToken });
      const calendar = google.calendar({ version: 'v3', auth: client });
      await calendar.events.delete({ calendarId, eventId });
    } catch (err: any) {
      if (err?.code === 404 || err?.code === 410) return; // already deleted, no-op
      throw err;
    }
  }

  private buildOAuthClient() {
    return new google.auth.OAuth2(
      this.configService.get<string>('GOOGLE_CALENDAR_CLIENT_ID'),
      this.configService.get<string>('GOOGLE_CALENDAR_CLIENT_SECRET'),
      this.configService.get<string>('GOOGLE_CALENDAR_REDIRECT_URI'),
    );
  }
}
