/** biome-ignore-all lint/style/useImportType: <> */
import {
  Availability,
  Booking,
  CalendarEncryptionService,
  CalendarProvider,
  ReaderCalendarConnection,
  ReaderProfile,
  TimeSlot,
  TimeSlotStatus,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CalendarTokenRefresherService } from './calendar-token-refresher.service';
import { GoogleCalendarService } from './google-calendar.service';
import { MicrosoftCalendarService } from './microsoft-calendar.service';

const SYNC_WINDOW_DAYS = 14;

@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: CalendarEncryptionService,
    private readonly googleCalendarService: GoogleCalendarService,
    private readonly microsoftCalendarService: MicrosoftCalendarService,
    private readonly tokenRefresher: CalendarTokenRefresherService,
  ) {}

  /**
   * C.3.8 — Inbound sync: query the reader's external calendar for busy intervals,
   * then mark overlapping CueActor time slots as BLOCKED (or unblock them if no longer busy).
   */
  async syncInboundForReader(
    readerProfileId: string,
  ): Promise<{ synced: number; failed: number }> {
    const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);
    const slotRepo = this.dataSource.getRepository(TimeSlot);
    const profileRepo = this.dataSource.getRepository(ReaderProfile);

    const profile = await profileRepo.findOne({
      where: { id: readerProfileId },
    });
    if (!profile) return { synced: 0, failed: 0 };

    // try each connected provider and merge busy intervals
    const connections = await connRepo.find({
      where: { readerProfileId, syncEnabled: true },
    });
    if (connections.length === 0) return { synced: 0, failed: 0 };

    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const busyIntervals: { start: string; end: string }[] = [];
    let synced = 0;
    let failed = 0;

    for (const connection of connections) {
      let accessToken: string;
      try {
        accessToken = await this.tokenRefresher.getValidAccessToken(connection);
      } catch {
        failed++;
        continue; // token refresh failed; error already logged on the connection
      }

      try {
        if (connection.provider === CalendarProvider.GOOGLE) {
          const calendarId = connection.externalCalendarId ?? 'primary';
          const intervals = await this.googleCalendarService.getFreeBusy(
            accessToken,
            calendarId,
            now,
            windowEnd,
          );
          busyIntervals.push(...intervals);
        } else if (connection.provider === CalendarProvider.OUTLOOK) {
          const intervals = await this.microsoftCalendarService.getFreeBusy(
            accessToken,
            now,
            windowEnd,
          );
          busyIntervals.push(...intervals);
        }
        await connRepo.update(connection.id, {
          lastSyncedAt: new Date(),
          lastErrorAt: undefined,
          lastErrorMessage: undefined,
        });
        synced++;
      } catch (err: any) {
        failed++;
        await connRepo.update(connection.id, {
          lastErrorAt: new Date(),
          lastErrorMessage: err.message?.slice(0, 500),
        });
        this.logger.warn(
          `Freebusy query failed for ${connection.provider} reader ${readerProfileId}: ${err.message}`,
        );
      }
    }

    // load all AVAILABLE and BLOCKED slots for this reader in the window
    const availabilityRepo = this.dataSource.getRepository(Availability);
    const availability = await availabilityRepo.findOne({
      where: { userId: profile.userId },
    });
    if (!availability) return;

    const slots = await slotRepo
      .createQueryBuilder('s')
      .where('s.availabilityId = :availId', { availId: availability.id })
      .andWhere('s.startTimeUtc IS NOT NULL')
      .andWhere('s.startTimeUtc >= :now', { now })
      .andWhere('s.startTimeUtc <= :windowEnd', { windowEnd })
      .andWhere('s.status IN (:...statuses)', {
        statuses: [TimeSlotStatus.AVAILABLE, TimeSlotStatus.BLOCKED],
      })
      .getMany();

    const toBlock: string[] = [];
    const toUnblock: string[] = [];

    for (const slot of slots) {
      const slotStart = slot.startTimeUtc!.getTime();
      const slotEnd = slot.endTimeUtc!.getTime();

      const overlaps = busyIntervals.some((b) => {
        const busyStart = new Date(b.start).getTime();
        const busyEnd = new Date(b.end).getTime();
        return slotStart < busyEnd && slotEnd > busyStart;
      });

      if (overlaps && slot.status === TimeSlotStatus.AVAILABLE) {
        toBlock.push(slot.id);
      } else if (!overlaps && slot.status === TimeSlotStatus.BLOCKED) {
        toUnblock.push(slot.id);
      }
    }

    if (toBlock.length > 0) {
      await slotRepo
        .createQueryBuilder()
        .update()
        .set({ status: TimeSlotStatus.BLOCKED })
        .whereInIds(toBlock)
        .execute();
      this.logger.log(
        `Blocked ${toBlock.length} slots for reader ${readerProfileId}`,
      );
    }

    if (toUnblock.length > 0) {
      await slotRepo
        .createQueryBuilder()
        .update()
        .set({ status: TimeSlotStatus.AVAILABLE })
        .whereInIds(toUnblock)
        .execute();
      this.logger.log(
        `Unblocked ${toUnblock.length} slots for reader ${readerProfileId}`,
      );
    }

    return { synced, failed };
  }

  /**
   * C.3.10 / C.4 — Outbound sync: push a confirmed booking as an event into the reader's
   * connected calendar(s). Stores the external event ID on booking.metaData.
   * Fire-and-forget safe — errors are swallowed with a warning.
   */
  async pushBookingEvent(bookingId: string): Promise<void> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);
    const profileRepo = this.dataSource.getRepository(ReaderProfile);

    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking) return;

    const profile = await profileRepo.findOne({
      where: { userId: booking.readerUserId },
    });
    if (!profile) return;

    const connections = await connRepo.find({
      where: { readerProfileId: profile.id, syncEnabled: true },
    });

    for (const connection of connections) {
      let accessToken: string;
      try {
        accessToken = await this.tokenRefresher.getValidAccessToken(connection);
      } catch {
        continue;
      }

      const eventParams = {
        summary: 'CueActor Script Reading Session',
        description: `${booking.sessionDurationMinutes}-minute CueActor session.\nBooking ID: ${booking.id}`,
        startUtc: booking.sessionStartUtc,
        endUtc: booking.sessionEndUtc,
        bookingId: booking.id,
      };

      try {
        if (connection.provider === CalendarProvider.GOOGLE) {
          const calendarId = connection.externalCalendarId ?? 'primary';
          const eventId = await this.googleCalendarService.createEvent(
            accessToken,
            calendarId,
            eventParams,
          );
          await bookingRepo
            .createQueryBuilder()
            .update()
            .set({
              metaData: () =>
                `COALESCE("metaData", '{}') || '{"googleEventId":"${eventId}"}'::jsonb`,
            })
            .where('id = :id', { id: bookingId })
            .execute();
          this.logger.log(
            `Google Calendar event ${eventId} created for booking ${bookingId}`,
          );
        } else if (connection.provider === CalendarProvider.OUTLOOK) {
          const eventId = await this.microsoftCalendarService.createEvent(
            accessToken,
            eventParams,
          );
          await bookingRepo
            .createQueryBuilder()
            .update()
            .set({
              metaData: () =>
                `COALESCE("metaData", '{}') || '{"outlookEventId":"${eventId}"}'::jsonb`,
            })
            .where('id = :id', { id: bookingId })
            .execute();
          this.logger.log(
            `Outlook Calendar event ${eventId} created for booking ${bookingId}`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to push booking event to ${connection.provider} for booking ${bookingId}: ${err.message}`,
        );
      }
    }
  }

  /**
   * C.3.11 — Delete the external calendar event when a confirmed booking is cancelled.
   * Best-effort — errors are swallowed.
   */
  async deleteBookingEvent(
    bookingId: string,
    provider: CalendarProvider,
  ): Promise<void> {
    const bookingRepo = this.dataSource.getRepository(Booking);
    const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);
    const profileRepo = this.dataSource.getRepository(ReaderProfile);

    const booking = await bookingRepo.findOne({ where: { id: bookingId } });
    if (!booking?.metaData) return;

    const eventId: string | undefined =
      provider === CalendarProvider.GOOGLE
        ? booking.metaData.googleEventId
        : booking.metaData.outlookEventId;

    if (!eventId) return;

    const profile = await profileRepo.findOne({
      where: { userId: booking.readerUserId },
    });
    if (!profile) return;

    const connection = await connRepo.findOne({
      where: { readerProfileId: profile.id, provider },
    });
    if (!connection) return;

    let accessToken: string;
    try {
      accessToken = await this.tokenRefresher.getValidAccessToken(connection);
    } catch {
      return;
    }

    try {
      if (provider === CalendarProvider.GOOGLE) {
        const calendarId = connection.externalCalendarId ?? 'primary';
        await this.googleCalendarService.deleteEvent(
          accessToken,
          calendarId,
          eventId,
        );
        this.logger.log(
          `Google Calendar event ${eventId} deleted for booking ${bookingId}`,
        );
      } else if (provider === CalendarProvider.OUTLOOK) {
        await this.microsoftCalendarService.deleteEvent(accessToken, eventId);
        this.logger.log(
          `Outlook Calendar event ${eventId} deleted for booking ${bookingId}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to delete calendar event for booking ${bookingId}: ${err.message}`,
      );
    }
  }
}
