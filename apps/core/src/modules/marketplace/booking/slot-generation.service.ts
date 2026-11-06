/** biome-ignore-all lint/style/useImportType: <> */

import {
  Availability,
  dayOfWeekToNumber,
  formatDateStr,
  ReaderProfile,
  ReaderSessionRate,
  TimeSlot,
  TimeSlotStatus,
  timeToUTC,
  User,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, MoreThan } from 'typeorm';

const GENERATION_WINDOW_DAYS = 14;

/** Parse a time string (HH:mm or HH:mm:ss) into total minutes from midnight. */
function timeStrToMinutes(time: string): number {
  const parts = time.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/** Convert total minutes from midnight to HH:mm:ss string. */
function minutesToTimeStr(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

@Injectable()
export class SlotGenerationService {
  private readonly logger = new Logger(SlotGenerationService.name);

  constructor(private readonly dataSource: DataSource) {}

  // generate concrete sub-slots for a reader for the next N days.
  // each availability window (e.g. 06:00–18:00) is broken into individual bookable
  // sub-slots at intervals equal to the reader's shortest session duration.
  // actors can then pick any specific start time rather than always getting the earliest.
  async generateSlotsForReader(readerId: string): Promise<number> {
    const userId = await this.resolveUserId(readerId);
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const availRepo = manager.getRepository(Availability);
      const slotRepo = manager.getRepository(TimeSlot);
      const profileRepo = manager.getRepository(ReaderProfile);
      const rateRepo = manager.getRepository(ReaderSessionRate);

      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) return 0;

      const profile = await profileRepo.findOne({ where: { userId } });
      if (!profile) return 0;

      // determine slot interval from reader's shortest offered session duration
      const rates = await rateRepo.find({
        where: { readerProfileId: profile.id },
      });
      if (!rates.length) {
        this.logger.warn(
          `Slot generation skipped for user ${userId}: no session rates defined`,
        );
        return 0;
      }
      const slotIntervalMinutes = Math.min(
        ...rates.map((r) => r.durationMinutes),
      );

      const availability = await availRepo.findOne({
        where: { userId },
        relations: ['timeSlots'],
      });
      if (!availability || !availability.timeSlots?.length) return 0;

      const timezone = user.timezone || 'UTC';

      // template slots are those without a concrete date
      const templates = availability.timeSlots.filter((s) => !s.date);

      const now = new Date();
      const generatedSlots: Partial<TimeSlot>[] = [];

      for (let dayOffset = 0; dayOffset < GENERATION_WINDOW_DAYS; dayOffset++) {
        const targetDate = new Date(now);
        targetDate.setUTCDate(targetDate.getUTCDate() + dayOffset);
        const dateStr = formatDateStr(targetDate);
        const targetDayNum = targetDate.getUTCDay(); // 0=Sun..6=Sat

        const matchingTemplates = templates.filter(
          (t) => dayOfWeekToNumber(t.dayOfWeek) === targetDayNum,
        );

        for (const template of matchingTemplates) {
          const windowStartMinutes = timeStrToMinutes(template.startTime);
          const windowEndMinutes = timeStrToMinutes(template.endTime);

          // skip if the window is too narrow to fit even one sub-slot
          if (windowEndMinutes - windowStartMinutes < slotIntervalMinutes) {
            this.logger.warn(
              `Availability window ${template.startTime}–${template.endTime} on ${dateStr} is narrower than the ${slotIntervalMinutes}-min interval — skipping`,
            );
            continue;
          }

          // step through the window, generating one sub-slot per interval
          for (
            let startMin = windowStartMinutes;
            startMin + slotIntervalMinutes <= windowEndMinutes;
            startMin += slotIntervalMinutes
          ) {
            const subSlotStartTime = minutesToTimeStr(startMin);
            const subSlotEndTime = minutesToTimeStr(
              startMin + slotIntervalMinutes,
            );

            // idempotency: skip if a concrete slot already exists for this date + startTime
            const existing = await slotRepo.findOne({
              where: {
                availabilityId: availability.id,
                date: dateStr,
                startTime: subSlotStartTime,
              },
            });
            if (existing) continue;

            // convert sub-slot local times to UTC for this specific date (handles DST)
            const startUtc = timeToUTC(subSlotStartTime, dateStr, timezone);
            const endUtc = timeToUTC(subSlotEndTime, dateStr, timezone);

            // skip if already in the past
            if (startUtc <= now) continue;

            generatedSlots.push({
              availabilityId: availability.id,
              dayOfWeek: template.dayOfWeek,
              startTime: subSlotStartTime,
              endTime: subSlotEndTime,
              date: dateStr,
              startTimeUtc: startUtc,
              endTimeUtc: endUtc,
              status: TimeSlotStatus.AVAILABLE,
            });
          }
        }
      }

      if (generatedSlots.length > 0) {
        try {
          await slotRepo.save(generatedSlots.map((s) => slotRepo.create(s)));
          this.logger.log(
            `Generated ${generatedSlots.length} sub-slots for user ${userId} (interval: ${slotIntervalMinutes}min)`,
          );
        } catch (error) {
          if (error.code === '23505') {
            // sub-slots already created by a concurrent request — safe to ignore
            this.logger.warn(
              `Slot generation skipped for user ${userId}: slots already exist (concurrent request)`,
            );
          } else {
            throw error;
          }
        }
      }

      return generatedSlots.length;
    });
  }

  // get available concrete sub-slots for a reader on a specific date.
  // returns slots with times optionally converted to the requester's timezone.
  async getAvailableSlots(
    readerId: string,
    date: string,
    requesterTimezone?: string,
  ) {
    const slotRepo = this.dataSource.getRepository(TimeSlot);
    const availRepo = this.dataSource.getRepository(Availability);

    const userId = await this.resolveUserId(readerId);

    const availability = await availRepo.findOne({
      where: { userId },
    });
    if (!availability)
      return {
        success: true,
        message: 'Available slots retrieved successfully',
        data: [],
      };

    // only return slots that are available and haven't started yet
    const slots = await slotRepo.find({
      where: {
        availabilityId: availability.id,
        date,
        status: TimeSlotStatus.AVAILABLE,
        startTimeUtc: MoreThan(new Date()),
      },
      order: { startTimeUtc: 'ASC' },
    });

    if (requesterTimezone) {
      const { fromUTC } = await import('@app/common');
      const slots_tz = slots.map((slot) => ({
        ...slot,
        startTimeLocal: slot.startTimeUtc
          ? fromUTC(slot.startTimeUtc, requesterTimezone)
          : null,
        endTimeLocal: slot.endTimeUtc
          ? fromUTC(slot.endTimeUtc, requesterTimezone)
          : null,
        displayTimezone: requesterTimezone,
      }));
      return {
        success: true,
        message: 'Available slots retrieved successfully',
        data: slots_tz,
      };
    }

    return {
      success: true,
      message: 'Available slots retrieved successfully',
      data: slots,
    };
  }

  // accept either a userId or a readerProfileId — resolve to userId in both cases.
  private async resolveUserId(id: string): Promise<string> {
    const profileRepo = this.dataSource.getRepository(ReaderProfile);
    const profile = await profileRepo.findOne({ where: { id } });
    return profile ? profile.userId : id;
  }
}
