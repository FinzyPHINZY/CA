/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Availability, DayOfWeek, TimeSlot } from '@app/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AvailabilityService } from './availability.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    ...overrides,
  };
}

describe('AvailabilityService', () => {
  let service: AvailabilityService;

  let availRepo: ReturnType<typeof mockRepository>;
  let slotRepo: ReturnType<typeof mockRepository>;

  const userId = 'user-1';

  beforeEach(() => {
    availRepo = mockRepository();
    slotRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[Availability.name] = availRepo;
    repoMap[TimeSlot.name] = slotRepo;

    const mockQueryBuilder = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };

    const mockManager = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    service = new AvailabilityService(mockDataSource);
  });

  // ─── updateAvailability ───────────────────────────────────────────

  describe('updateAvailability', () => {
    it('should create new availability if none exists', async () => {
      availRepo.findOne
        .mockResolvedValueOnce(null) // first call: no existing
        .mockResolvedValueOnce({
          id: 'avail-1',
          userId,
          timeSlots: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }); // second call: fetch updated

      const result = await service.updateAvailability(userId, { days: [] });

      expect(availRepo.create).toHaveBeenCalledWith({ userId });
      expect(availRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should replace time slots when days are provided', async () => {
      availRepo.findOne
        .mockResolvedValueOnce({
          id: 'avail-1',
          userId,
          timeSlots: [{ id: 'old-slot' }],
        })
        .mockResolvedValueOnce({
          id: 'avail-1',
          userId,
          timeSlots: [
            {
              dayOfWeek: DayOfWeek.MONDAY,
              startTime: '09:00',
              endTime: '17:00',
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      await service.updateAvailability(userId, {
        days: [
          {
            dayOfWeek: DayOfWeek.MONDAY,
            timeRanges: [{ startTime: '09:00', endTime: '17:00' }],
          },
        ],
      });

      expect(slotRepo.save).toHaveBeenCalled();
    });

    it('should throw if start time is not before end time', async () => {
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [],
      });

      await expect(
        service.updateAvailability(userId, {
          days: [
            {
              dayOfWeek: DayOfWeek.MONDAY,
              timeRanges: [{ startTime: '17:00', endTime: '09:00' }],
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if start equals end time', async () => {
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [],
      });

      await expect(
        service.updateAvailability(userId, {
          days: [
            {
              dayOfWeek: DayOfWeek.TUESDAY,
              timeRanges: [{ startTime: '10:00', endTime: '10:00' }],
            },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should handle multiple days with multiple ranges', async () => {
      availRepo.findOne
        .mockResolvedValueOnce({
          id: 'avail-1',
          userId,
          timeSlots: [],
        })
        .mockResolvedValueOnce({
          id: 'avail-1',
          userId,
          timeSlots: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      await service.updateAvailability(userId, {
        days: [
          {
            dayOfWeek: DayOfWeek.MONDAY,
            timeRanges: [
              { startTime: '09:00', endTime: '12:00' },
              { startTime: '13:00', endTime: '17:00' },
            ],
          },
          {
            dayOfWeek: DayOfWeek.WEDNESDAY,
            timeRanges: [{ startTime: '10:00', endTime: '15:00' }],
          },
        ],
      });

      const savedSlots = slotRepo.save.mock.calls[0][0];
      expect(savedSlots).toHaveLength(3);
    });
  });

  // ─── getAvailability ──────────────────────────────────────────────

  describe('getAvailability', () => {
    it('should return empty days when no availability exists', async () => {
      availRepo.findOne.mockResolvedValue(null);

      const result = await service.getAvailability(userId);

      expect(result.data.userId).toBe(userId);
      expect(result.data.days).toHaveLength(7);
      for (const day of result.data.days) {
        expect(day.timeRanges).toEqual([]);
      }
    });

    it('should return grouped time slots by day', async () => {
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [
          {
            id: 'slot-1',
            dayOfWeek: DayOfWeek.MONDAY,
            startTime: '09:00',
            endTime: '17:00',
            date: null,
          },
          {
            id: 'slot-2',
            dayOfWeek: DayOfWeek.FRIDAY,
            startTime: '10:00',
            endTime: '14:00',
            date: null,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.getAvailability(userId);

      const monday = result.data.days.find(
        (d: any) => d.dayOfWeek === DayOfWeek.MONDAY,
      );
      const friday = result.data.days.find(
        (d: any) => d.dayOfWeek === DayOfWeek.FRIDAY,
      );
      expect(monday.timeRanges).toHaveLength(1);
      expect(friday.timeRanges).toHaveLength(1);
      expect(monday.timeRanges[0].startTime).toBe('09:00');
    });
  });

  // ─── deleteTimeRange ──────────────────────────────────────────────

  describe('deleteTimeRange', () => {
    it('should delete matching time range', async () => {
      availRepo.findOne.mockResolvedValue({ id: 'avail-1', userId });
      slotRepo.delete.mockResolvedValue({ affected: 1 });

      const result = await service.deleteTimeRange(userId, {
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '17:00',
      });

      expect(result.message).toContain('deleted');
      expect(slotRepo.delete).toHaveBeenCalledWith({
        availabilityId: 'avail-1',
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '17:00',
      });
    });

    it('should throw if availability not found', async () => {
      availRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteTimeRange(userId, {
          dayOfWeek: DayOfWeek.MONDAY,
          startTime: '09:00',
          endTime: '17:00',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw if time range not found', async () => {
      availRepo.findOne.mockResolvedValue({ id: 'avail-1', userId });
      slotRepo.delete.mockResolvedValue({ affected: 0 });

      await expect(
        service.deleteTimeRange(userId, {
          dayOfWeek: DayOfWeek.SATURDAY,
          startTime: '09:00',
          endTime: '17:00',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
