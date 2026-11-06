/** biome-ignore-all lint/style/useImportType: <> */
import {
  CalendarEncryptionService,
  ReaderCalendarConnection,
} from '@app/common';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GoogleCalendarService } from './google-calendar.service';
import { MicrosoftCalendarService } from './microsoft-calendar.service';

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

@Injectable()
export class CalendarTokenRefresherService {
  private readonly logger = new Logger(CalendarTokenRefresherService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: CalendarEncryptionService,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly microsoftCalendarService: MicrosoftCalendarService,
  ) {}

  /**
   * Returns a valid (non-expired) access token for the given connection.
   * Refreshes and persists the new token automatically if the current one is expiring.
   * Throws InternalServerErrorException if the connection has no refresh token
   * or if the refresh fails (e.g. user revoked access).
   */
  async getValidAccessToken(
    connection: ReaderCalendarConnection,
  ): Promise<string> {
    const expiresAt = connection.tokenExpiresAt;
    const needsRefresh =
      !expiresAt || expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;

    if (!needsRefresh && connection.accessTokenEncrypted) {
      return this.encryptionService.decrypt(connection.accessTokenEncrypted);
    }

    if (!connection.refreshTokenEncrypted) {
      throw new InternalServerErrorException(
        `Calendar connection ${connection.id} has no refresh token — cannot refresh access token`,
      );
    }

    try {
      let refreshed: { accessToken: string; expiresAt: Date };
      if (connection.provider === 'google') {
        refreshed = await this.googleCalendarService.refreshAccessToken(
          connection.refreshTokenEncrypted,
        );
      } else if (connection.provider === 'outlook') {
        refreshed = await this.microsoftCalendarService.refreshAccessToken(
          connection.refreshTokenEncrypted,
        );
      } else {
        throw new Error(
          `Token refresh not implemented for provider: ${connection.provider}`,
        );
      }

      // persist updated tokens
      const repo = this.dataSource.getRepository(ReaderCalendarConnection);
      await repo.update(connection.id, {
        accessTokenEncrypted: this.encryptionService.encrypt(
          refreshed.accessToken,
        ),
        tokenExpiresAt: refreshed.expiresAt,
        lastErrorAt: undefined,
        lastErrorMessage: undefined,
      });

      this.logger.log(`Access token refreshed for connection ${connection.id}`);
      return refreshed.accessToken;
    } catch (err: any) {
      // record the failure on the connection — sync job will skip this reader
      const repo = this.dataSource.getRepository(ReaderCalendarConnection);
      await repo.update(connection.id, {
        lastErrorAt: new Date(),
        lastErrorMessage: err.message?.slice(0, 500),
      });
      this.logger.warn(
        `Token refresh failed for connection ${connection.id}: ${err.message}`,
      );
      throw new InternalServerErrorException(
        `Token refresh failed: ${err.message}`,
      );
    }
  }
}
