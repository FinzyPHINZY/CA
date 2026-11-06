/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { ConnectPaymentService } from './connect-payment.service';
import { SlotGenerationService } from './slot-generation.service';

describe('BookingController', () => {
  let controller: BookingController;
  let bookingService: jest.Mocked<Partial<BookingService>>;
  let slotGenerationService: jest.Mocked<Partial<SlotGenerationService>>;
  let connectPaymentService: jest.Mocked<Partial<ConnectPaymentService>>;

  const mockReq = { user: { id: 'user-1' } };

  beforeEach(() => {
    bookingService = {
      createBooking: jest.fn().mockResolvedValue({ id: 'booking-1' }),
      listBookings: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      getBooking: jest.fn().mockResolvedValue({ id: 'booking-1' }),
      cancelByActor: jest.fn().mockResolvedValue({ id: 'booking-1' }),
      cancelByReader: jest.fn().mockResolvedValue({ id: 'booking-1' }),
    };

    slotGenerationService = {
      generateSlotsForReader: jest.fn().mockResolvedValue(0),
      getAvailableSlots: jest.fn().mockResolvedValue([]),
    };

    connectPaymentService = {
      createConnectedPaymentIntent: jest
        .fn()
        .mockResolvedValue({ clientSecret: 'cs_test' }),
      getPaymentHistory: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      getReaderEarnings: jest.fn().mockResolvedValue({ totalEarnedCents: 0 }),
    };

    const instantConnectService = {
      requestInstantConnect: jest.fn(),
      acceptInstantConnect: jest.fn(),
      declineInstantConnect: jest.fn(),
    };

    controller = new BookingController(
      bookingService as unknown as BookingService,
      slotGenerationService as unknown as SlotGenerationService,
      connectPaymentService as unknown as ConnectPaymentService,
      instantConnectService as any,
    );
  });

  describe('getReaderAvailability', () => {
    it('should generate slots then return available slots', async () => {
      const result = await controller.getReaderAvailability('reader-1', {
        date: '2026-03-15',
        timezone: 'America/New_York',
      });

      expect(slotGenerationService.generateSlotsForReader).toHaveBeenCalledWith(
        'reader-1',
      );
      expect(slotGenerationService.getAvailableSlots).toHaveBeenCalledWith(
        'reader-1',
        '2026-03-15',
        'America/New_York',
      );
      expect(result).toEqual([]);
    });
  });

  describe('createBooking', () => {
    it('should delegate to bookingService with user ID and DTO', async () => {
      const dto = { timeSlotId: 'slot-1', readerProfileId: 'profile-1' };
      await controller.createBooking(mockReq, dto as any);

      expect(bookingService.createBooking).toHaveBeenCalledWith('user-1', dto);
    });
  });

  describe('listBookings', () => {
    it('should pass role, status, and pagination params', async () => {
      await controller.listBookings(mockReq, 'actor', 'CONFIRMED', 2, 10);

      expect(bookingService.listBookings).toHaveBeenCalledWith('user-1', {
        role: 'actor',
        status: 'CONFIRMED',
        page: 2,
        limit: 10,
      });
    });

    it('should default page=1 and limit=20 when not provided', async () => {
      await controller.listBookings(mockReq);

      expect(bookingService.listBookings).toHaveBeenCalledWith('user-1', {
        role: undefined,
        status: undefined,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('getBooking', () => {
    it('should delegate with booking ID and user ID', async () => {
      await controller.getBooking(mockReq, 'booking-1');

      expect(bookingService.getBooking).toHaveBeenCalledWith(
        'booking-1',
        'user-1',
      );
    });
  });

  describe('cancelByActor', () => {
    it('should delegate with booking ID, user ID, and reason', async () => {
      await controller.cancelByActor(mockReq, 'booking-1', {
        reason: 'Schedule conflict',
      });

      expect(bookingService.cancelByActor).toHaveBeenCalledWith(
        'booking-1',
        'user-1',
        'Schedule conflict',
      );
    });
  });

  describe('cancelByReader', () => {
    it('should delegate with booking ID, user ID, and reason', async () => {
      await controller.cancelByReader(mockReq, 'booking-1', {
        reason: 'Emergency',
      });

      expect(bookingService.cancelByReader).toHaveBeenCalledWith(
        'booking-1',
        'user-1',
        'Emergency',
      );
    });
  });

  describe('createPayment', () => {
    it('should delegate to connectPaymentService', async () => {
      await controller.createPayment('booking-1');

      expect(
        connectPaymentService.createConnectedPaymentIntent,
      ).toHaveBeenCalledWith('booking-1');
    });
  });

  describe('getPaymentHistory', () => {
    it('should pass role and pagination params', async () => {
      await controller.getPaymentHistory(mockReq, 'actor', 2, 10);

      expect(connectPaymentService.getPaymentHistory).toHaveBeenCalledWith(
        'user-1',
        { role: 'actor', page: 2, limit: 10 },
      );
    });

    it('should default page=1 and limit=20', async () => {
      await controller.getPaymentHistory(mockReq);

      expect(connectPaymentService.getPaymentHistory).toHaveBeenCalledWith(
        'user-1',
        { role: undefined, page: 1, limit: 20 },
      );
    });
  });

  describe('getReaderEarnings', () => {
    it('should delegate with user ID', async () => {
      await controller.getReaderEarnings(mockReq);

      expect(connectPaymentService.getReaderEarnings).toHaveBeenCalledWith(
        'user-1',
      );
    });
  });
});
