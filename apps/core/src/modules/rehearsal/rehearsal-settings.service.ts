import {
  AuthClientService,
  CharacterRepository,
  Rehersal,
  RehersalRepository,
  RehearsalStatus,
  SESSION_DEFAULTS,
  SessionSettings,
  normalizeDetectionMode,
} from '@app/common';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UpdateRehearsalSettingsDto } from './dto/update-rehearsal-settings.dto';

export interface RehearsalCharacterSummary {
  id: string;
  name: string;
}

interface EffectiveLayers {
  effective: SessionSettings;
  frozen: boolean;
}

export interface VoiceContext {
  voiceMap: Record<string, string> | null;
  voiceMapFrozen: boolean;
  characters: RehearsalCharacterSummary[];
}

export interface ResolvedRehearsalSettings
  extends EffectiveLayers,
    VoiceContext {}

// Block behavioral setting changes only during active playback.
// PREPARING and READY are pre-session states — settings are frozen at
// session.start (WebSocket), not at prepare time, so changes in that
// window are valid and will take effect.
export const LOCKED_STATUSES = new Set<RehearsalStatus>([
  RehearsalStatus.ACTIVE,
  RehearsalStatus.PAUSED,
]);

@Injectable()
export class RehearsalSettingsService {
  private readonly logger = new Logger(RehearsalSettingsService.name);

  constructor(
    private readonly rehearsalRepo: RehersalRepository,
    private readonly authClient: AuthClientService,
    private readonly characterRepo: CharacterRepository,
  ) {}

  /**
   * Returns the effective session settings for a rehearsal.
   *
   * `frozen` reflects whether settings are currently immutable — derived from
   * status (ACTIVE/PAUSED), not from snapshot presence. The frozen snapshot is
   * authoritative only while the session is live; in any other state we
   * re-resolve from layers (override → user default → system default) so that
   * pending edits to the override are visible.
   */
  async getEffectiveSettings(
    rehearsalId: string,
    userId: string,
  ): Promise<ResolvedRehearsalSettings> {
    const rehearsal = await this.rehearsalRepo.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal ${rehearsalId} not found`);
    }
    if (rehearsal.userId !== userId) {
      throw new ForbiddenException('Not authorized for this rehearsal');
    }

    const voiceContext = await this.loadVoiceContext(rehearsal);
    let isFrozen = LOCKED_STATUSES.has(rehearsal.status);

    if (isFrozen && rehearsal.startedAt) {
      const sessionAgeMs = Date.now() - rehearsal.startedAt.getTime();
      const maxSessionMs = 4 * 60 * 60 * 1000;
      if (sessionAgeMs > maxSessionMs) {
        this.logger.warn(
          `Rehearsal ${rehearsalId} stuck in ${rehearsal.status} for ${Math.round(sessionAgeMs / 60000)}min — correcting to CANCELLED`,
        );
        await this.rehearsalRepo.updateById(rehearsalId, {
          status: RehearsalStatus.CANCELLED,
          endedAt: new Date(),
        });
        isFrozen = false;
      }
    }

    if (isFrozen && rehearsal.sessionSettings) {
      return {
        effective: { ...SESSION_DEFAULTS, ...rehearsal.sessionSettings },
        frozen: true,
        ...voiceContext,
      };
    }

    const override =
      (rehearsal.metaData?.settingsOverride as
        | Partial<SessionSettings>
        | undefined) ?? null;
    const resolved = await this.resolveLayers(rehearsal.userId, override);
    return { ...resolved, frozen: isFrozen, ...voiceContext };
  }

  /**
   * Updates per-rehearsal session setting overrides.
   * Rejected only while playback is live (ACTIVE/PAUSED). A previously-frozen
   * snapshot from an earlier run does not block edits — the snapshot is
   * cleared so the next session.start re-freezes with the updated override.
   */
  async updateRehearsalSettings(
    rehearsalId: string,
    userId: string,
    dto: UpdateRehearsalSettingsDto,
  ): Promise<ResolvedRehearsalSettings> {
    const rehearsal = await this.rehearsalRepo.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal ${rehearsalId} not found`);
    }
    if (rehearsal.userId !== userId) {
      throw new ForbiddenException('Not authorized for this rehearsal');
    }

    if (LOCKED_STATUSES.has(rehearsal.status)) {
      throw new BadRequestException(
        'Cannot change settings while rehearsal playback is in progress',
      );
    }

    const currentOverride =
      (rehearsal.metaData?.settingsOverride as
        | Partial<SessionSettings>
        | undefined) ?? {};
    const nextOverride: Partial<SessionSettings> = { ...currentOverride };
    for (const key of Object.keys(
      dto,
    ) as (keyof UpdateRehearsalSettingsDto)[]) {
      if (key === 'voiceMap') continue;
      const value = dto[key];
      if (value !== undefined) {
        (nextOverride as any)[key] = value;
      }
    }

    const nextMeta: Record<string, any> = {
      ...(rehearsal.metaData ?? {}),
      settingsOverride: nextOverride,
    };

    if (dto.voiceMap !== undefined) {
      const currentVoiceMap =
        (rehearsal.metaData?.voiceMap as Record<string, string> | undefined) ??
        {};
      nextMeta.voiceMap = { ...currentVoiceMap, ...dto.voiceMap };
    }

    const updatePatch: Partial<Rehersal> = { metaData: nextMeta };
    if (rehearsal.sessionSettings) {
      updatePatch.sessionSettings = null;
    }
    await this.rehearsalRepo.updateById(rehearsalId, updatePatch);

    const resolved = await this.resolveLayers(rehearsal.userId, nextOverride);
    const voiceContext = await this.loadVoiceContext({
      ...rehearsal,
      metaData: nextMeta,
    });
    return { ...resolved, ...voiceContext };
  }

  /**
   * Snapshot effective settings into rehearsal.sessionSettings.
   * Called by session start (booked reader + Hazel prepare).
   * Idempotent — no-op if already frozen.
   */
  async freezeSettings(rehearsalId: string): Promise<SessionSettings> {
    const rehearsal = await this.rehearsalRepo.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal ${rehearsalId} not found`);
    }

    if (rehearsal.sessionSettings) {
      return rehearsal.sessionSettings;
    }

    const override =
      (rehearsal.metaData?.settingsOverride as
        | Partial<SessionSettings>
        | undefined) ?? null;
    const resolved = await this.resolveLayers(rehearsal.userId, override);

    await this.rehearsalRepo.updateById(rehearsalId, {
      sessionSettings: resolved.effective,
    });

    this.logger.log(
      `Settings frozen for rehearsal ${rehearsalId}: ${JSON.stringify(resolved.effective)}`,
    );

    return resolved.effective;
  }

  private async loadVoiceContext(rehearsal: Rehersal): Promise<VoiceContext> {
    const voiceMap =
      (rehearsal.metaData?.voiceMap as Record<string, string> | undefined) ??
      null;
    const voiceMapFrozen = LOCKED_STATUSES.has(rehearsal.status);

    if (!rehearsal.scriptId) {
      return { voiceMap, voiceMapFrozen, characters: [] };
    }

    const allCharacters = await this.characterRepo.findByScriptId(
      rehearsal.scriptId,
    );
    const actorCharacterId = rehearsal.characterId;
    const characters: RehearsalCharacterSummary[] = allCharacters
      .filter((c) => c.id !== actorCharacterId)
      .map((c) => ({ id: c.id, name: c.name }));

    return { voiceMap, voiceMapFrozen, characters };
  }

  private async resolveLayers(
    userId: string,
    override: Partial<SessionSettings> | null,
  ): Promise<EffectiveLayers> {
    const userPrefs = await this.authClient.getUserRehearsalPreferences(userId);
    const userSession = userPrefs.sessionDefaults;

    const effective: SessionSettings = {
      detectionMode: normalizeDetectionMode(
        override?.detectionMode ?? userSession.detectionMode,
      ),
      wordTracking:
        override?.wordTracking ??
        userSession.wordTracking ??
        SESSION_DEFAULTS.wordTracking,
      autoRecord:
        override?.autoRecord ??
        userSession.autoRecord ??
        SESSION_DEFAULTS.autoRecord,
      loopMode:
        override?.loopMode ?? userSession.loopMode ?? SESSION_DEFAULTS.loopMode,
    };

    return { effective, frozen: false };
  }
}
