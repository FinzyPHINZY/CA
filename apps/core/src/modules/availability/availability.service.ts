/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { Availability, DayOfWeek, TimeSlot, TimeSlotStatus } from '@app/common';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DeleteTimeRangeDto } from './dto/delete-time-range.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';

@Injectable()
export class AvailabilityService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Create or update user availability
   */
  async updateAvailability(
    userId: string,
    dto: UpdateAvailabilityDto,
  ): Promise<any> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const availabilityRepo = manager.getRepository(Availability);
      const timeSlotRepo = manager.getRepository(TimeSlot);

      // Find or create availability for user
      let availability = await availabilityRepo.findOne({
        where: { userId },
        relations: { timeSlots: true },
      });

      if (!availability) {
        availability = availabilityRepo.create({ userId });
        availability = await availabilityRepo.save(availability);
      }

      // Clear only template slots (date IS NULL) — leave generated/booked slots intact
      if (dto.days && dto.days.length > 0) {
        await manager
          .createQueryBuilder()
          .delete()
          .from(TimeSlot)
          .where('"availabilityId" = :id', { id: availability.id })
          .andWhere('date IS NULL')
          .execute();

        // Also clean up stale future concrete slots for affected days.
        // When a reader changes their schedule, previously generated concrete
        // slots no longer match the new template. Only delete AVAILABLE slots
        // — booked/held slots must be honoured.
        const affectedDays = dto.days.map((d) => d.dayOfWeek);
        const today = new Date().toISOString().slice(0, 10);

        await manager
          .createQueryBuilder()
          .delete()
          .from(TimeSlot)
          .where('"availabilityId" = :id', { id: availability.id })
          .andWhere('date IS NOT NULL')
          .andWhere('date >= :today', { today })
          .andWhere('"dayOfWeek" IN (:...affectedDays)', { affectedDays })
          .andWhere('status = :status', { status: TimeSlotStatus.AVAILABLE })
          .execute();
      }

      // Create new template slots, deduplicating by dayOfWeek+startTime+endTime
      const seen = new Set<string>();
      const timeSlots: TimeSlot[] = [];
      if (dto.days) {
        for (const dayAvailability of dto.days) {
          if (
            dayAvailability.timeRanges &&
            dayAvailability.timeRanges.length > 0
          ) {
            for (const timeRange of dayAvailability.timeRanges) {
              this.validateTimeRange(timeRange.startTime, timeRange.endTime);

              const key = `${dayAvailability.dayOfWeek}|${timeRange.startTime}|${timeRange.endTime}`;
              if (seen.has(key)) continue;
              seen.add(key);

              const timeSlot = timeSlotRepo.create({
                availabilityId: availability.id,
                dayOfWeek: dayAvailability.dayOfWeek,
                startTime: timeRange.startTime,
                endTime: timeRange.endTime,
              });
              timeSlots.push(timeSlot);
            }
          }
        }
      }

      if (timeSlots.length > 0) {
        try {
          await timeSlotRepo.save(timeSlots);
        } catch (error) {
          if (error.code === '23505') {
            throw new ConflictException(
              'Duplicate time range: each day and time combination must be unique',
            );
          }
          throw error;
        }
      }

      // Fetch updated availability with time slots
      const updatedAvailability = await availabilityRepo.findOne({
        where: { id: availability.id },
        relations: { timeSlots: true },
      });

      return {
        success: true,
        message: 'Availability updated successfully',
        data: this.buildAvailabilityResponse(updatedAvailability),
      };
    });
  }

  /**
   * Get user availability
   */
  async getAvailability(userId: string): Promise<any> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const availabilityRepo = manager.getRepository(Availability);

      const availability = await availabilityRepo.findOne({
        where: { userId },
        relations: { timeSlots: true },
      });

      if (!availability) {
        return {
          success: true,
          message: 'Availability retrieved successfully',
          data: {
            userId,
            days: this.buildEmptyDaysResponse(),
          },
        };
      }

      return {
        success: true,
        message: 'Availability retrieved successfully',
        data: this.buildAvailabilityResponse(availability),
      };
    });
  }

  /**
   * Delete a specific time range from a day
   */
  async deleteTimeRange(
    userId: string,
    dto: DeleteTimeRangeDto,
  ): Promise<{ message: string }> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const availabilityRepo = manager.getRepository(Availability);
      const timeSlotRepo = manager.getRepository(TimeSlot);

      const availability = await availabilityRepo.findOne({
        where: { userId },
      });

      if (!availability) {
        throw new NotFoundException('Availability not found for user');
      }

      const deleted = await timeSlotRepo.delete({
        availabilityId: availability.id,
        dayOfWeek: dto.dayOfWeek,
        startTime: dto.startTime,
        endTime: dto.endTime,
      });

      if (deleted.affected === 0) {
        throw new NotFoundException(
          'Time range not found for the specified day',
        );
      }

      return {
        success: true,
        message: 'Time range deleted successfully',
      };
    });
  }

  /**
   * Validate time range (start < end)
   */
  private validateTimeRange(startTime: string, endTime: string): void {
    const start = this.timeToMinutes(startTime);
    const end = this.timeToMinutes(endTime);

    if (start >= end) {
      throw new BadRequestException('Start time must be before end time');
    }
  }

  /**
   * Convert time string (HH:mm) to minutes
   */
  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Build availability response grouped by day
   */
  private buildAvailabilityResponse(availability: Availability): any {
    const daysMap = new Map<DayOfWeek, any[]>();

    // Initialize all days with empty arrays
    Object.values(DayOfWeek).forEach((day) => {
      daysMap.set(day, []);
    });

    // Group template slots only (date IS NULL = recurring weekly pattern)
    // Generated concrete-date slots must not appear in the availability template view
    if (availability.timeSlots && availability.timeSlots.length > 0) {
      for (const timeSlot of availability.timeSlots) {
        if (timeSlot.date !== null) continue;
        const existing = daysMap.get(timeSlot.dayOfWeek) || [];
        existing.push({
          id: timeSlot.id,
          startTime: timeSlot.startTime,
          endTime: timeSlot.endTime,
        });
        daysMap.set(timeSlot.dayOfWeek, existing);
      }
    }

    // Build response array
    const days = Object.values(DayOfWeek).map((day) => ({
      dayOfWeek: day,
      timeRanges: daysMap.get(day) || [],
    }));

    return {
      id: availability.id,
      userId: availability.userId,
      days,
      createdAt: availability.createdAt,
      updatedAt: availability.updatedAt,
    };
  }

  /**
   * Build empty days response structure
   */
  private buildEmptyDaysResponse(): any[] {
    return Object.values(DayOfWeek).map((day) => ({
      dayOfWeek: day,
      timeRanges: [],
    }));
  }
}
