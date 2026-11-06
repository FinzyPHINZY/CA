/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { DISPLAY_DEFAULTS, SESSION_DEFAULTS, User } from '@app/common';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UserPreferencesService } from './user-preferences.service';

describe('UserPreferencesService', () => {
  let service: UserPreferencesService;
  let userRepo: any;
  let dataSource: DataSource;

  beforeEach(() => {
    userRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (u: User) => u),
    };
    dataSource = {
      getRepository: jest.fn(() => userRepo),
    } as unknown as DataSource;
    service = new UserPreferencesService(dataSource);
  });

  describe('getPreferences', () => {
    it('throws Unauthorized when no userId', async () => {
      await expect(service.getPreferences('')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws NotFound when user missing', async () => {
      userRepo.findOne.mockResolvedValue(null);
      await expect(service.getPreferences('u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns merged defaults when user has no overrides', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        displayPreferences: null,
        defaultSessionSettings: null,
      });

      const result = await service.getPreferences('u1');

      expect(result.display).toEqual(DISPLAY_DEFAULTS);
      expect(result.sessionDefaults).toEqual(SESSION_DEFAULTS);
    });

    it('overrides defaults with stored values', async () => {
      userRepo.findOne.mockResolvedValue({
        id: 'u1',
        displayPreferences: { fontSize: 22, hideStageDirections: true },
        defaultSessionSettings: { detectionMode: 'AUTO', loopMode: true },
      });

      const result = await service.getPreferences('u1');

      expect(result.display.fontSize).toBe(22);
      expect(result.display.hideStageDirections).toBe(true);
      // unset display field falls back to default
      expect(result.display.theme).toBe(DISPLAY_DEFAULTS.theme);
      expect(result.sessionDefaults.detectionMode).toBe('AUTO');
      expect(result.sessionDefaults.loopMode).toBe(true);
      expect(result.sessionDefaults.autoRecord).toBe(
        SESSION_DEFAULTS.autoRecord,
      );
    });
  });

  describe('updatePreferences', () => {
    it('partial-updates display only', async () => {
      const user = {
        id: 'u1',
        displayPreferences: { fontSize: 14 },
        defaultSessionSettings: null,
      } as any;
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.updatePreferences('u1', {
        display: { fontSize: 24 },
      });

      expect(user.displayPreferences.fontSize).toBe(24);
      expect(user.defaultSessionSettings).toBeNull();
      expect(result.display.fontSize).toBe(24);
    });

    it('partial-updates session defaults only', async () => {
      const user = {
        id: 'u1',
        displayPreferences: null,
        defaultSessionSettings: null,
      } as any;
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.updatePreferences('u1', {
        sessionDefaults: { detectionMode: 'MANUAL' },
      });

      expect(user.defaultSessionSettings.detectionMode).toBe('MANUAL');
      expect(result.sessionDefaults.detectionMode).toBe('MANUAL');
      // other session defaults stay at system defaults
      expect(result.sessionDefaults.autoRecord).toBe(
        SESSION_DEFAULTS.autoRecord,
      );
    });

    it('enables wordTracking when set to true', async () => {
      const user = {
        id: 'u1',
        displayPreferences: null,
        defaultSessionSettings: null,
      } as any;
      userRepo.findOne.mockResolvedValue(user);

      const result = await service.updatePreferences('u1', {
        sessionDefaults: { wordTracking: true },
      });

      expect(user.defaultSessionSettings.wordTracking).toBe(true);
      expect(result.sessionDefaults.wordTracking).toBe(true);
      // other session defaults stay at system defaults
      expect(result.sessionDefaults.loopMode).toBe(SESSION_DEFAULTS.loopMode);
    });

    it('throws Unauthorized when no userId', async () => {
      await expect(
        service.updatePreferences('', { display: { fontSize: 18 } }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
