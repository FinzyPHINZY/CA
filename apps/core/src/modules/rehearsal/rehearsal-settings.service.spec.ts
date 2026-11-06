/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import {
  AuthClientService,
  CharacterRepository,
  RehearsalStatus,
  RehersalRepository,
  SESSION_DEFAULTS,
  SessionSettings,
} from '@app/common';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RehearsalSettingsService } from './rehearsal-settings.service';

describe('RehearsalSettingsService', () => {
  let service: RehearsalSettingsService;
  let rehearsalRepo: any;
  let authClient: any;
  let characterRepo: any;

  const baseUserPrefs = {
    display: {},
    sessionDefaults: { ...SESSION_DEFAULTS },
  };

  beforeEach(() => {
    rehearsalRepo = {
      findById: jest.fn(),
      updateById: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    authClient = {
      getUserRehearsalPreferences: jest.fn().mockResolvedValue(baseUserPrefs),
    };
    characterRepo = {
      findByScriptId: jest.fn().mockResolvedValue([]),
    };
    service = new RehearsalSettingsService(
      rehearsalRepo as RehersalRepository,
      authClient as AuthClientService,
      characterRepo as CharacterRepository,
    );
  });

  describe('getEffectiveSettings', () => {
    it('returns frozen snapshot when status is ACTIVE and sessionSettings is set', async () => {
      const frozen: SessionSettings = {
        detectionMode: 'AUTO',
        wordTracking: false,
        autoRecord: true,
        loopMode: false,
      };
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.ACTIVE,
        sessionSettings: frozen,
        metaData: null,
      });

      const result = await service.getEffectiveSettings('r1', 'u1');

      expect(result.frozen).toBe(true);
      expect(result.effective).toEqual(frozen);
      expect(authClient.getUserRehearsalPreferences).not.toHaveBeenCalled();
    });

    it('re-resolves layers (with override) when status is unlocked even if sessionSettings is populated', async () => {
      const stale: SessionSettings = {
        detectionMode: 'AUTO',
        wordTracking: false,
        autoRecord: true,
        loopMode: false,
      };
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.READY,
        sessionSettings: stale,
        metaData: {
          settingsOverride: { detectionMode: 'LISTEN' },
        },
      });

      const result = await service.getEffectiveSettings('r1', 'u1');

      expect(result.frozen).toBe(false);
      expect(result.effective.detectionMode).toBe('LISTEN');
      expect(authClient.getUserRehearsalPreferences).toHaveBeenCalled();
    });

    it('resolves layers when not frozen', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.CREATED,
        sessionSettings: null,
        metaData: null,
      });

      const result = await service.getEffectiveSettings('r1', 'u1');

      expect(result.frozen).toBe(false);
      expect(result.effective).toEqual(SESSION_DEFAULTS);
    });

    it('throws ForbiddenException when not owner', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'other-user',
        sessionSettings: null,
      });

      await expect(
        service.getEffectiveSettings('r1', 'u1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException when missing', async () => {
      rehearsalRepo.findById.mockResolvedValue(null);

      await expect(
        service.getEffectiveSettings('r1', 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns voiceMap and non-actor characters from metaData', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        scriptId: 's1',
        characterId: 'char-actor',
        status: RehearsalStatus.CREATED,
        sessionSettings: null,
        metaData: {
          voiceMap: { 'char-b': 'voice-b', 'char-c': 'voice-c' },
        },
      });
      characterRepo.findByScriptId.mockResolvedValue([
        { id: 'char-actor', name: 'Hero' },
        { id: 'char-b', name: 'Villain' },
        { id: 'char-c', name: 'Sidekick' },
      ]);

      const result = await service.getEffectiveSettings('r1', 'u1');

      expect(result.voiceMap).toEqual({
        'char-b': 'voice-b',
        'char-c': 'voice-c',
      });
      expect(result.voiceMapFrozen).toBe(false);
      expect(result.characters).toEqual([
        { id: 'char-b', name: 'Villain' },
        { id: 'char-c', name: 'Sidekick' },
      ]);
    });

    it('marks voiceMap frozen when rehearsal is ACTIVE', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        scriptId: null,
        status: RehearsalStatus.ACTIVE,
        sessionSettings: { ...SESSION_DEFAULTS },
        metaData: { voiceMap: { 'char-b': 'voice-b' } },
      });

      const result = await service.getEffectiveSettings('r1', 'u1');

      expect(result.voiceMapFrozen).toBe(true);
      expect(result.voiceMap).toEqual({ 'char-b': 'voice-b' });
      expect(result.characters).toEqual([]);
    });
  });

  describe('updateRehearsalSettings', () => {
    it('clears the stale snapshot when updating an unlocked rehearsal that has sessionSettings populated', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.CREATED,
        sessionSettings: { ...SESSION_DEFAULTS },
        metaData: null,
      });

      await service.updateRehearsalSettings('r1', 'u1', {
        detectionMode: 'AUTO',
      });

      expect(rehearsalRepo.updateById).toHaveBeenCalledWith('r1', {
        metaData: { settingsOverride: { detectionMode: 'AUTO' } },
        sessionSettings: null,
      });
    });

    it('rejects when status is ACTIVE', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.ACTIVE,
        sessionSettings: null,
        metaData: null,
      });

      await expect(
        service.updateRehearsalSettings('r1', 'u1', { loopMode: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when status is PAUSED', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.PAUSED,
        sessionSettings: null,
        metaData: null,
      });

      await expect(
        service.updateRehearsalSettings('r1', 'u1', { loopMode: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('merges override into metaData', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.CREATED,
        sessionSettings: null,
        metaData: { other: 'preserved' },
      });

      const result = await service.updateRehearsalSettings('r1', 'u1', {
        detectionMode: 'MANUAL',
        loopMode: true,
      });

      expect(rehearsalRepo.updateById).toHaveBeenCalledWith('r1', {
        metaData: {
          other: 'preserved',
          settingsOverride: { detectionMode: 'MANUAL', loopMode: true },
        },
      });
      expect(result.effective.detectionMode).toBe('MANUAL');
      expect(result.effective.loopMode).toBe(true);
      // unset fields fall back to defaults
      expect(result.effective.autoRecord).toBe(SESSION_DEFAULTS.autoRecord);
    });

    it('enables wordTracking when set to true', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        status: RehearsalStatus.CREATED,
        sessionSettings: null,
        metaData: null,
      });

      const result = await service.updateRehearsalSettings('r1', 'u1', {
        wordTracking: true,
      });

      expect(rehearsalRepo.updateById).toHaveBeenCalledWith('r1', {
        metaData: { settingsOverride: { wordTracking: true } },
      });
      expect(result.effective.wordTracking).toBe(true);
      // unset fields still fall back to defaults
      expect(result.effective.loopMode).toBe(SESSION_DEFAULTS.loopMode);
    });
  });

  describe('freezeSettings', () => {
    it('returns existing snapshot if already frozen', async () => {
      const frozen: SessionSettings = {
        detectionMode: 'LISTEN',
        wordTracking: true,
        autoRecord: false,
        loopMode: true,
      };
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        sessionSettings: frozen,
        metaData: null,
      });

      const result = await service.freezeSettings('r1');

      expect(result).toEqual(frozen);
      expect(rehearsalRepo.updateById).not.toHaveBeenCalled();
    });

    it('resolves and writes snapshot when none exists', async () => {
      rehearsalRepo.findById.mockResolvedValue({
        id: 'r1',
        userId: 'u1',
        sessionSettings: null,
        metaData: { settingsOverride: { detectionMode: 'AUTO' } },
      });

      const result = await service.freezeSettings('r1');

      expect(result.detectionMode).toBe('AUTO');
      expect(rehearsalRepo.updateById).toHaveBeenCalledWith('r1', {
        sessionSettings: result,
      });
    });
  });
});
