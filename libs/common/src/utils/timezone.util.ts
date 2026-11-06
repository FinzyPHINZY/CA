/**
 * Timezone conversion utilities.
 * Uses native Intl.DateTimeFormat — no external library needed.
 * All database times are stored as UTC. Conversion happens at API boundaries.
 */

/**
 * Convert a local date/time string to a UTC Date.
 * @param localDateStr - ISO-like string in local time (e.g. "2025-03-15T09:00:00")
 * @param ianaTimezone - IANA timezone string (e.g. "America/New_York")
 * @returns Date object in UTC
 */
export function toUTC(localDateStr: string, ianaTimezone: string): Date {
  // Parse the local date components
  const [datePart, timePart] = localDateStr.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second] = (timePart || '00:00:00')
    .split(':')
    .map(Number);

  // Get the UTC offset for this timezone at this date/time
  const offsetMinutes = getTimezoneOffsetMinutes(
    ianaTimezone,
    year,
    month,
    day,
    hour,
    minute,
  );

  // Create a UTC date by subtracting the offset
  const utc = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second || 0) +
      offsetMinutes * 60 * 1000,
  );

  return utc;
}

/**
 * Convert a UTC Date to a local time string in a specific timezone.
 * @param utcDate - Date object in UTC
 * @param ianaTimezone - IANA timezone string (e.g. "America/New_York")
 * @returns ISO-like string in local time (e.g. "2025-03-15T09:00:00")
 */
export function fromUTC(utcDate: Date, ianaTimezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcDate);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value || '00';

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Convert a HH:mm time string on a specific date from one timezone to UTC.
 * Used for converting reader availability times to UTC.
 */
export function timeToUTC(
  time: string,
  date: string,
  ianaTimezone: string,
): Date {
  return toUTC(`${date}T${time}:00`, ianaTimezone);
}

/**
 * Get the day of week (0=Sunday..6=Saturday) for a UTC date in a specific timezone.
 */
export function getDayOfWeekInTimezone(
  utcDate: Date,
  ianaTimezone: string,
): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimezone,
    weekday: 'short',
  });
  const weekday = formatter.format(utcDate);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[weekday] ?? 0;
}

/**
 * Map DayOfWeek enum string to JS day number (0=Sunday..6=Saturday).
 */
export function dayOfWeekToNumber(day: string): number {
  const map: Record<string, number> = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };
  return map[day.toUpperCase()] ?? 0;
}

/**
 * Get the next N dates for a specific day of week from a start date.
 */
export function getNextDatesForDay(
  dayOfWeek: string,
  startDate: Date,
  count: number,
): Date[] {
  const targetDay = dayOfWeekToNumber(dayOfWeek);
  const dates: Date[] = [];
  const current = new Date(startDate);

  for (let i = 0; i < 90 && dates.length < count; i++) {
    if (current.getUTCDay() === targetDay) {
      dates.push(new Date(current));
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

/**
 * Format a date as YYYY-MM-DD string.
 */
export function formatDateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Validate an IANA timezone string.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the UTC offset in minutes for a timezone at a specific date/time.
 * Positive = east of UTC, negative = west of UTC.
 * Note: We negate the result because we need the offset to ADD to local time to get UTC.
 */
function getTimezoneOffsetMinutes(
  ianaTimezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  // Create a date in UTC
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));

  // Format the same instant in the target timezone
  const localStr = fromUTC(utcDate, ianaTimezone);
  const [datePart, timePart] = localStr.split('T');
  const [ly, lm, ld] = datePart.split('-').map(Number);
  const [lh, lmin] = timePart.split(':').map(Number);

  // The difference tells us the offset
  const localMs = Date.UTC(ly, lm - 1, ld, lh, lmin);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute);

  // offset = local - utc (in minutes, negated for conversion direction)
  return -(localMs - utcMs) / (60 * 1000);
}
