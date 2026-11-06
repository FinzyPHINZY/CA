/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { DayOfWeek } from '@app/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

describe('AvailabilityController', () => {
  let controller: AvailabilityController;
  let availabilityService: jest.Mocked<Partial<AvailabilityService>>;

  const mockReq = { user: { id: 'user-1' } };

  beforeEach(() => {
    availabilityService = {
      updateAvailability: jest
        .fn()
        .mockResolvedValue({ id: 'avail-1', days: [] }),
      getAvailability: jest
        .fn()
        .mockResolvedValue({ userId: 'user-1', days: [] }),
      deleteTimeRange: jest
        .fn()
        .mockResolvedValue({ message: 'Time range deleted successfully' }),
    };

    controller = new AvailabilityController(
      availabilityService as unknown as AvailabilityService,
    );
  });

  describe('updateAvailability', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = {
        days: [
          {
            dayOfWeek: DayOfWeek.MONDAY,
            timeRanges: [{ startTime: '09:00', endTime: '17:00' }],
          },
        ],
      };

      await controller.updateAvailability(mockReq, dto as any);

      expect(availabilityService.updateAvailability).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
    });
  });

  describe('getAvailability', () => {
    it('should delegate with userId', async () => {
      const result = await controller.getAvailability(mockReq);

      expect(availabilityService.getAvailability).toHaveBeenCalledWith(
        'user-1',
      );
      expect(result.userId).toBe('user-1');
    });
  });

  describe('deleteTimeRange', () => {
    it('should delegate with userId and DTO', async () => {
      const dto = {
        dayOfWeek: DayOfWeek.MONDAY,
        startTime: '09:00',
        endTime: '17:00',
      };

      const result = await controller.deleteTimeRange(mockReq, dto as any);

      expect(availabilityService.deleteTimeRange).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
      expect(result.message).toContain('deleted');
    });
  });
});
