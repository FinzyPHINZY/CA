/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Availability,
  DayOfWeek,
  ReaderProfile,
  ReaderSessionRate,
  TimeSlot,
  TimeSlotStatus,
  User,
} from '@app/common';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SlotGenerationService } from './slot-generation.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data) => ({ ...data })),
    save: jest.fn((entities) =>
      Promise.resolve(Array.isArray(entities) ? entities : [entities]),
    ),
    ...overrides,
  };
}

describe('SlotGenerationService', () => {
  let service: SlotGenerationService;

  let userRepo: ReturnType<typeof mockRepository>;
  let availRepo: ReturnType<typeof mockRepository>;
  let slotRepo: ReturnType<typeof mockRepository>;
  let profileRepo: ReturnType<typeof mockRepository>;
  let rateRepo: ReturnType<typeof mockRepository>;

  const userId = 'user-1';

  /** Return the DayOfWeek enum value for a date N days from today (UTC). */
  function futureDayOfWeek(offsetDays: number): DayOfWeek {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    const dayNames = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];
    return dayNames[d.getUTCDay()];
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    userRepo = mockRepository();
    availRepo = mockRepository();
    slotRepo = mockRepository();
    profileRepo = mockRepository();
    rateRepo = mockRepository();

    // default: reader offers one 30-min session rate
    rateRepo.find.mockResolvedValue([{ durationMinutes: 30 }]);

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {};
    repoMap[User.name] = userRepo;
    repoMap[Availability.name] = availRepo;
    repoMap[TimeSlot.name] = slotRepo;
    repoMap[ReaderProfile.name] = profileRepo;
    repoMap[ReaderSessionRate.name] = rateRepo;

    const mockManager = {
      getRepository: jest.fn((entity) => repoMap[entity.name]),
    };

    const mockDataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(mockManager)),
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    service = new SlotGenerationService(mockDataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── generateSlotsForReader ─────────────────────────────────────────

  describe('generateSlotsForReader', () => {
    it('should return 0 if user not found', async () => {
      userRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
    });

    it('should return 0 if user has no reader profile', async () => {
      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
    });

    it('should return 0 if no availability set', async () => {
      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ userId });
      availRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
    });

    it('should return 0 if availability has no template slots', async () => {
      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ userId });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [],
      });

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
    });

    it('should generate slots for matching days in 14-day window', async () => {
      // Figure out what day of week today is and create a template for it
      const now = new Date();
      const todayDayNum = now.getUTCDay();
      const dayNames = [
        DayOfWeek.SUNDAY,
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
        DayOfWeek.SATURDAY,
      ];
      const todayDayName = dayNames[todayDayNum];

      // Template slot (no date = template)
      const templateSlot = {
        dayOfWeek: todayDayName,
        startTime: '09:00',
        endTime: '17:00',
        date: null, // template
      };

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ userId, bufferMinutes: 10 });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [templateSlot],
      });

      // No existing concrete slots
      slotRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      // Should generate at least 1 slot (for the same day of week within 14 days)
      // There are 2 occurrences of any day within 14 days (today + 7 days later)
      // But today's slot might be in the past depending on time, so at least 1
      expect(count).toBeGreaterThanOrEqual(1);
      expect(slotRepo.save).toHaveBeenCalled();

      // Verify saved slots have AVAILABLE status
      const savedSlots = slotRepo.save.mock.calls[0][0];
      for (const slot of savedSlots) {
        expect(slot.status).toBe(TimeSlotStatus.AVAILABLE);
        expect(slot.date).toBeDefined();
        expect(slot.startTimeUtc).toBeInstanceOf(Date);
        expect(slot.endTimeUtc).toBeInstanceOf(Date);
      }
    });

    it('should skip slots that already exist (idempotent)', async () => {
      const now = new Date();
      const todayDayNum = now.getUTCDay();
      const dayNames = [
        DayOfWeek.SUNDAY,
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
        DayOfWeek.SATURDAY,
      ];

      const templateSlot = {
        dayOfWeek: dayNames[todayDayNum],
        startTime: '09:00',
        endTime: '17:00',
        date: null,
      };

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ userId, bufferMinutes: 10 });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [templateSlot],
      });

      // All slots already exist
      slotRepo.findOne.mockResolvedValue({ id: 'existing-slot' });

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
    });

    it('should use user timezone for UTC conversion', async () => {
      // Use a day 7 days from now to avoid "in the past" issues
      const futureDate = new Date();
      futureDate.setUTCDate(futureDate.getUTCDate() + 7);
      const futureDayNum = futureDate.getUTCDay();
      const dayNames = [
        DayOfWeek.SUNDAY,
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
        DayOfWeek.SATURDAY,
      ];

      const templateSlot = {
        dayOfWeek: dayNames[futureDayNum],
        startTime: '09:00',
        endTime: '17:00',
        date: null,
      };

      userRepo.findOne.mockResolvedValue({
        id: userId,
        timezone: 'America/New_York',
      });
      profileRepo.findOne.mockResolvedValue({ userId, bufferMinutes: 10 });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [templateSlot],
      });
      slotRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBeGreaterThanOrEqual(1);

      // Verify the UTC times are offset from local (New York is UTC-5 or UTC-4)
      const savedSlots = slotRepo.save.mock.calls[0][0];
      const slot = savedSlots.find((s: any) => s.startTime === '09:00');
      if (slot) {
        const startHourUtc = slot.startTimeUtc.getUTCHours();
        // 9am ET = 13:00 or 14:00 UTC depending on DST
        expect(startHourUtc).toBeGreaterThanOrEqual(13);
        expect(startHourUtc).toBeLessThanOrEqual(14);
      }
    });

    it('should default to UTC when user has no timezone', async () => {
      const futureDate = new Date();
      futureDate.setUTCDate(futureDate.getUTCDate() + 7);
      const futureDayNum = futureDate.getUTCDay();
      const dayNames = [
        DayOfWeek.SUNDAY,
        DayOfWeek.MONDAY,
        DayOfWeek.TUESDAY,
        DayOfWeek.WEDNESDAY,
        DayOfWeek.THURSDAY,
        DayOfWeek.FRIDAY,
        DayOfWeek.SATURDAY,
      ];

      const templateSlot = {
        dayOfWeek: dayNames[futureDayNum],
        startTime: '09:00',
        endTime: '17:00',
        date: null,
      };

      userRepo.findOne.mockResolvedValue({ id: userId }); // no timezone
      profileRepo.findOne.mockResolvedValue({ userId, bufferMinutes: 10 });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [templateSlot],
      });
      slotRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      expect(count).toBeGreaterThanOrEqual(1);

      // UTC timezone: 9am local = 9am UTC
      const savedSlots = slotRepo.save.mock.calls[0][0];
      const slot = savedSlots.find((s: any) => s.startTime === '09:00');
      if (slot) {
        expect(slot.startTimeUtc.getUTCHours()).toBe(9);
      }
    });
  });

  // ─── sub-slot generation behaviour ─────────────────────────────────

  describe('sub-slot generation', () => {
    it('returns 0 and logs a warning when reader has no session rates', async () => {
      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', userId });
      rateRepo.find.mockResolvedValue([]); // override default — no rates

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no session rates defined'),
      );
    });

    it('generates 24 sub-slots for a 06:00–18:00 window with a 30-min interval', async () => {
      // Freeze time to 19:00 UTC so today's slots (all starting ≤17:30) are in the past.
      // Day +7 then has exactly 24 future sub-slots.
      jest.useFakeTimers().setSystemTime(new Date('2099-01-01T19:00:00Z'));
      const dayOfWeek = futureDayOfWeek(7);

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', userId });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [
          { dayOfWeek, startTime: '06:00', endTime: '18:00', date: null },
        ],
      });
      slotRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      jest.useRealTimers();

      // 720 min window / 30 min interval = 24 sub-slots
      expect(count).toBe(24);

      const savedSlots = slotRepo.save.mock.calls[0][0];
      expect(savedSlots).toHaveLength(24);
      // first and last sub-slot boundaries
      expect(savedSlots[0].startTime).toBe('06:00:00');
      expect(savedSlots[0].endTime).toBe('06:30:00');
      expect(savedSlots[23].startTime).toBe('17:30:00');
      expect(savedSlots[23].endTime).toBe('18:00:00');
    });

    it('stops at the last valid start time — window boundary is respected', async () => {
      // Freeze time to 09:30 UTC so 09:00 is in the past and 10:00+ are future.
      // That leaves only the 10:00 and 10:30 sub-slots from today, since 11:00 is the window end.
      jest.useFakeTimers().setSystemTime(new Date('2099-01-01T09:30:00Z'));
      const dayOfWeek = futureDayOfWeek(7); // day+7 also matches but is 7 days away

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', userId });
      // 60-min window, 30-min interval → 2 sub-slots (10:00 and 10:30), not 11:00
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [
          { dayOfWeek, startTime: '10:00', endTime: '11:00', date: null },
        ],
      });
      slotRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      jest.useRealTimers();

      // 2 per matching day × 2 matching days (today + day+7) = 4
      expect(count).toBe(4);
      const savedSlots = slotRepo.save.mock.calls[0][0];
      // Every saved slot starts either 10:00 or 10:30 — never 11:00 (the window end)
      for (const slot of savedSlots) {
        expect(['10:00:00', '10:30:00']).toContain(slot.startTime);
      }
      expect(savedSlots.some((s: any) => s.startTime === '11:00:00')).toBe(
        false,
      );
    });

    it('skips a window that is narrower than the slot interval', async () => {
      const dayOfWeek = futureDayOfWeek(7);

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', userId });
      // 20-min window with 30-min interval — no valid sub-slot fits
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [
          { dayOfWeek, startTime: '10:00', endTime: '10:20', date: null },
        ],
      });

      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const count = await service.generateSlotsForReader(userId);

      expect(count).toBe(0);
      expect(slotRepo.save).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('narrower than the'),
      );
    });

    it('uses the shortest offered session duration as the slot interval', async () => {
      // Freeze time past the window end so only day+7 contributes (exactly 2 sub-slots)
      jest.useFakeTimers().setSystemTime(new Date('2099-01-01T19:00:00Z'));
      const dayOfWeek = futureDayOfWeek(7);

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', userId });
      // Reader offers 30-min and 60-min sessions — interval must be 30 (shortest)
      rateRepo.find.mockResolvedValue([
        { durationMinutes: 60 },
        { durationMinutes: 30 },
      ]);
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [
          { dayOfWeek, startTime: '10:00', endTime: '11:00', date: null },
        ],
      });
      slotRepo.findOne.mockResolvedValue(null);

      const count = await service.generateSlotsForReader(userId);

      jest.useRealTimers();
      // 60-min window / 30-min interval = 2 sub-slots for day+7 (today's are in the past)
      expect(count).toBe(2);
    });

    it('generates all sub-slots with AVAILABLE status and correct UTC timestamps', async () => {
      const dayOfWeek = futureDayOfWeek(7);

      userRepo.findOne.mockResolvedValue({ id: userId, timezone: 'UTC' });
      profileRepo.findOne.mockResolvedValue({ id: 'profile-1', userId });
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId,
        timeSlots: [
          { dayOfWeek, startTime: '09:00', endTime: '10:00', date: null },
        ],
      });
      slotRepo.findOne.mockResolvedValue(null);

      await service.generateSlotsForReader(userId);

      const savedSlots = slotRepo.save.mock.calls[0][0];
      expect(savedSlots.length).toBeGreaterThan(0);
      for (const slot of savedSlots) {
        expect(slot.status).toBe(TimeSlotStatus.AVAILABLE);
        expect(slot.startTimeUtc).toBeInstanceOf(Date);
        expect(slot.endTimeUtc).toBeInstanceOf(Date);
        expect(slot.startTimeUtc.getTime()).toBeLessThan(
          slot.endTimeUtc.getTime(),
        );
      }
    });
  });

  // ─── getAvailableSlots ──────────────────────────────────────────────

  describe('getAvailableSlots', () => {
    it('should return empty array if reader has no availability', async () => {
      availRepo.findOne.mockResolvedValue(null);

      const result = await service.getAvailableSlots('reader-1', '2026-03-01');

      expect(result.data).toEqual([]);
    });

    it('should return only AVAILABLE slots for the date', async () => {
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId: 'reader-1',
      });
      const slots = [
        {
          id: 'slot-1',
          status: TimeSlotStatus.AVAILABLE,
          startTimeUtc: new Date('2026-03-01T14:00:00Z'),
          endTimeUtc: new Date('2026-03-01T15:00:00Z'),
        },
      ];
      slotRepo.find.mockResolvedValue(slots);

      const result = await service.getAvailableSlots('reader-1', '2026-03-01');

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('slot-1');
    });

    it('should convert times to requester timezone when provided', async () => {
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId: 'reader-1',
      });
      const slots = [
        {
          id: 'slot-1',
          status: TimeSlotStatus.AVAILABLE,
          startTimeUtc: new Date('2026-03-01T14:00:00Z'),
          endTimeUtc: new Date('2026-03-01T15:00:00Z'),
        },
      ];
      slotRepo.find.mockResolvedValue(slots);

      const result = await service.getAvailableSlots(
        'reader-1',
        '2026-03-01',
        'America/New_York',
      );

      expect(result.data).toHaveLength(1);
      expect((result.data[0] as any).displayTimezone).toBe('America/New_York');
      expect((result.data[0] as any).startTimeLocal).toBeDefined();
      expect((result.data[0] as any).endTimeLocal).toBeDefined();
      // 14:00 UTC = 09:00 EST
      expect((result.data[0] as any).startTimeLocal).toContain('09:00');
    });

    it('should not add timezone fields when no requester timezone', async () => {
      availRepo.findOne.mockResolvedValue({
        id: 'avail-1',
        userId: 'reader-1',
      });
      const slots = [
        {
          id: 'slot-1',
          status: TimeSlotStatus.AVAILABLE,
          startTimeUtc: new Date('2026-03-01T14:00:00Z'),
          endTimeUtc: new Date('2026-03-01T15:00:00Z'),
        },
      ];
      slotRepo.find.mockResolvedValue(slots);

      const result = await service.getAvailableSlots('reader-1', '2026-03-01');

      expect((result.data[0] as any).displayTimezone).toBeUndefined();
      expect((result.data[0] as any).startTimeLocal).toBeUndefined();
    });
  });
});
