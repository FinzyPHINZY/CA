import { Booking } from '@app/common';
import { Injectable } from '@nestjs/common';

/**
 * Generates iCalendar (.ics) content for a single booking.
 * Pure service — no database access. Used by CalendarFeedService and booking confirmation emails.
 */
@Injectable()
export class IcsGeneratorService {
  generateBookingIcs(
    booking: Booking,
    recipientRole: 'actor' | 'reader',
  ): string {
    const role = recipientRole === 'reader' ? 'Reader' : 'Actor';
    const summary = `CueActor Script Reading Session (${role})`;
    const description =
      `${booking.sessionDurationMinutes}-minute CueActor script reading session.\\n` +
      `Session ID: ${booking.id}`;

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CueActor//CueActor Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${booking.id}@cueactor.com`,
      `DTSTAMP:${this.toIcsDate(new Date())}`,
      `DTSTART:${this.toIcsDate(booking.sessionStartUtc)}`,
      `DTEND:${this.toIcsDate(booking.sessionEndUtc)}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
    ];

    return lines.join('\r\n');
  }

  toIcsDate(date: Date): string {
    return date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  }
}
