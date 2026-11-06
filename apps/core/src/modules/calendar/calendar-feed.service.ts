/** biome-ignore-all lint/style/useImportType: <> */
import { Booking, BookingStatus, User } from '@app/common';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { DataSource } from 'typeorm';
import { IcsGeneratorService } from './ics-generator.service';

@Injectable()
export class CalendarFeedService {
  private readonly logger = new Logger(CalendarFeedService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    private readonly icsGenerator: IcsGeneratorService,
  ) {}

  /**
   * Returns the reader's webcal feed URL, generating a feedToken if needed.
   */
  async getFeedUrl(userId: string): Promise<{
    feedUrl: string;
    httpUrl: string;
    instructions: { google: string; apple: string; outlook: string };
  }> {
    const token = await this.ensureFeedToken(userId);
    const baseUrl = this.configService.get<string>(
      'APP_BASE_URL',
      'http://localhost:3000',
    );
    const path = `/api/calendar/feed/${userId}/${token}.ics`;
    const httpUrl = `${baseUrl}${path}`;
    const feedUrl = httpUrl.replace(/^https?/, 'webcal');

    return {
      feedUrl,
      httpUrl,
      instructions: {
        google:
          'In Google Calendar, click the "+" next to "Other calendars", select "From URL", paste the URL above and click "Add calendar".',
        apple:
          'On iPhone/iPad: Go to Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, then paste the URL. On Mac: In Calendar app, click File → New Calendar Subscription, paste the URL.',
        outlook:
          'In Outlook.com, go to Calendar → Add calendar → Subscribe from web, paste the URL and click "Import".',
      },
    };
  }

  /**
   * Rotates the feedToken, invalidating the old feed URL immediately.
   */
  async rotateFeedToken(
    userId: string,
  ): Promise<{ feedUrl: string; httpUrl: string }> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    user.feedToken = crypto.randomUUID().replace(/-/g, '');
    await userRepo.save(user);

    const baseUrl = this.configService.get<string>(
      'APP_BASE_URL',
      'http://localhost:3000',
    );
    const path = `/api/calendar/feed/${userId}/${user.feedToken}.ics`;
    const httpUrl = `${baseUrl}${path}`;
    return { feedUrl: httpUrl.replace(/^https?/, 'webcal'), httpUrl };
  }

  /**
   * Generates and returns the ICS file content for a user.
   * Called by the public feed endpoint — validates token before building content.
   */
  async buildIcsContent(userId: string, token: string): Promise<string> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId } });

    if (!user || user.feedToken !== token) {
      throw new UnauthorizedException('Invalid calendar feed token');
    }

    const bookingRepo = this.dataSource.getRepository(Booking);
    const now = new Date();

    const bookings = await bookingRepo
      .createQueryBuilder('b')
      .where('(b.actorUserId = :userId OR b.readerUserId = :userId)', {
        userId,
      })
      .andWhere('b.status IN (:...statuses)', {
        statuses: [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS],
      })
      .andWhere('b.sessionEndUtc > :now', { now })
      .orderBy('b.sessionStartUtc', 'ASC')
      .getMany();

    return this.renderIcs(bookings, userId);
  }

  // --- private helpers ---
  // NOTE (C.5.2 — Apple Calendar): Apple Calendar polls webcal feeds every 15 minutes to
  // 24 hours depending on device settings. There is no server push mechanism for Apple.
  // This is acceptable — the webcal feed is outbound-only (confirmed sessions → Apple Calendar),
  // not inbound availability blocking. Apple users who need inbound blocking should be directed
  // toward the Google or Outlook OAuth integrations if they also have one of those accounts.
  // CalDAV is not implemented here; the webcal/ICS approach covers the vast majority of use cases.

  private async ensureFeedToken(userId: string): Promise<string> {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (!user.feedToken) {
      user.feedToken = crypto.randomUUID().replace(/-/g, '');
      await userRepo.save(user);
      this.logger.log(`Generated feedToken for user ${userId}`);
    }

    return user.feedToken;
  }

  private renderIcs(bookings: Booking[], userId: string): string {
    const header = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CueActor//CueActor Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:CueActor Sessions',
      'X-WR-CALDESC:Your upcoming CueActor script reading sessions',
      'X-PUBLISHED-TTL:PT30M',
      'REFRESH-INTERVAL;VALUE=DURATION:PT30M',
    ];

    const events: string[] = [];
    for (const booking of bookings) {
      const role = booking.readerUserId === userId ? 'reader' : 'actor';
      // Extract just the VEVENT block from the single-booking ICS
      const singleIcs = this.icsGenerator.generateBookingIcs(booking, role);
      const veventMatch = singleIcs.match(/BEGIN:VEVENT[\s\S]*END:VEVENT/);
      if (veventMatch) events.push(veventMatch[0]);
    }

    return [...header, ...events, 'END:VCALENDAR'].join('\r\n');
  }
}
