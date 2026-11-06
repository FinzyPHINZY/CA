import {
  AgoraSession,
  Booking,
  Character,
  Recording,
  RehearsalMode,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Rehersal,
  Scene,
  User,
  UserRepository,
} from '@app/common';
import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { LOCKED_STATUSES } from './rehearsal-settings.service';

export interface RehearsalPartnerSummary {
  type: string;
  displayName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  aiName: string | null;
  aiDescription: string | null;
  aiImage: string | null;
}

export interface RehearsalContentSummary {
  id: string | null;
  title?: string | null;
  number?: number | null;
  heading?: string | null;
}

export interface RehearsalBookingSummary {
  id: string;
  status: string;
  readerProfileId: string;
  sessionStartUtc: Date | null;
  sessionEndUtc: Date | null;
  sessionDurationMinutes: number;
}

export interface RehearsalRuntimeSummary {
  sessionId: string | null;
  channelName: string | null;
  status: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface RehearsalCharacterSummary {
  id: string;
  name: string;
}

export interface RehearsalSetupStateSummary {
  contentReady: boolean;
  roleSelectionRequired: boolean;
  roleSelected: boolean;
  runtimePrepared: boolean;
  canPrepareRuntime: boolean;
  canStartRuntime: boolean;
  selectedCharacterId: string | null;
  availableCharacterIds: string[];
  missingRequirements: string[];
}

export interface RehearsalRecordingsSummary {
  count: number;
  latestRecordingId: string | null;
  latestRecordingCreatedAt: Date | null;
}

export interface RehearsalAnalyticsSummary {
  computedAt: string | null;
  completionPct: number | null;
  avgResponseTimeMs: number | null;
}

export interface RehearsalReadModel {
  id: string;
  status: string;
  mode: string;
  runtimeEngine: string;
  startedAt: Date | null;
  endedAt: Date | null;
  sessionDurationSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
  partner: RehearsalPartnerSummary;
  project: RehearsalContentSummary | null;
  script: RehearsalContentSummary | null;
  scene: RehearsalContentSummary | null;
  booking: RehearsalBookingSummary | null;
  runtime: RehearsalRuntimeSummary | null;
  selectedCharacter: RehearsalCharacterSummary | null;
  setupState: RehearsalSetupStateSummary;
  recordingsSummary: RehearsalRecordingsSummary;
  analyticsSummary: RehearsalAnalyticsSummary;
  voiceMap: Record<string, string> | null;
  voiceMapFrozen: boolean;
}

@Injectable()
export class RehearsalReadModelService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly userRepository: UserRepository,
  ) {}

  async buildDetail(rehearsal: Rehersal): Promise<RehearsalReadModel> {
    const [partnerUser, booking, runtimeSession, fullScene, selectedCharacter] =
      await Promise.all([
        rehearsal.rehearsalPartnerUserId
          ? this.userRepository.findById(rehearsal.rehearsalPartnerUserId)
          : Promise.resolve(null),
        rehearsal.bookingId
          ? this.dataSource.getRepository(Booking).findOne({
              where: { id: rehearsal.bookingId },
            })
          : Promise.resolve(null),
        this.dataSource.getRepository(AgoraSession).findOne({
          where: { rehearsalId: rehearsal.id },
        }),
        rehearsal.sceneId
          ? this.dataSource.getRepository(Scene).findOne({
              where: { id: rehearsal.sceneId },
              relations: ['characters'],
            })
          : Promise.resolve(null),
        rehearsal.character
          ? Promise.resolve(rehearsal.character)
          : rehearsal.characterId
            ? this.dataSource.getRepository(Character).findOne({
                where: { id: rehearsal.characterId },
              })
            : Promise.resolve(null),
      ]);
    const availableCharacterIds = await this.resolveAvailableCharacterIds(
      fullScene ?? rehearsal.scene ?? null,
      rehearsal.scriptId,
    );

    const recordings = rehearsal.recordings ?? [];
    const latestRecording = this.getLatestRecording(recordings);
    const setupState = this.buildSetupState(
      rehearsal.mode,
      rehearsal.runtimeEngine,
      rehearsal.status,
      rehearsal.projectId,
      rehearsal.scriptId,
      rehearsal.sceneId,
      fullScene ?? rehearsal.scene ?? null,
      rehearsal.characterId,
      availableCharacterIds,
    );

    return {
      id: rehearsal.id,
      status: rehearsal.status,
      mode: rehearsal.mode,
      runtimeEngine: rehearsal.runtimeEngine,
      startedAt: rehearsal.startedAt,
      endedAt: rehearsal.endedAt,
      sessionDurationSeconds: rehearsal.sessionDurationSeconds,
      createdAt: rehearsal.createdAt,
      updatedAt: rehearsal.updatedAt,
      partner: this.buildPartnerSummary(
        {
          rehearsalPartnerType: rehearsal.rehearsalPartnerType,
          rehearsalPartnerUserId: rehearsal.rehearsalPartnerUserId,
          rehearsalPartnerAiName: rehearsal.rehearsalPartnerAiName,
          rehearsalPartnerAiDescription:
            rehearsal.rehearsalPartnerAiDescription,
          rehearsalPartnerAiImage: rehearsal.rehearsalPartnerAiImage,
        },
        partnerUser,
      ),
      project: rehearsal.project
        ? {
            id: rehearsal.project.id,
            title: (rehearsal.project as any).title ?? null,
          }
        : rehearsal.projectId
          ? { id: rehearsal.projectId, title: null }
          : null,
      script: rehearsal.script
        ? {
            id: rehearsal.script.id,
            title: (rehearsal.script as any).title ?? null,
          }
        : rehearsal.scriptId
          ? { id: rehearsal.scriptId, title: null }
          : null,
      scene:
        (fullScene ?? rehearsal.scene)
          ? {
              id: (fullScene ?? rehearsal.scene)!.id,
              number: (fullScene ?? rehearsal.scene)!.number ?? null,
              heading: (fullScene ?? rehearsal.scene)!.heading ?? null,
            }
          : rehearsal.sceneId
            ? { id: rehearsal.sceneId, number: null, heading: null }
            : null,
      booking: booking ? this.buildBookingSummary(booking) : null,
      runtime: runtimeSession ? this.buildRuntimeSummary(runtimeSession) : null,
      selectedCharacter: selectedCharacter
        ? { id: selectedCharacter.id, name: selectedCharacter.name }
        : rehearsal.characterId
          ? { id: rehearsal.characterId, name: 'Unknown Character' }
          : null,
      setupState,
      recordingsSummary: {
        count: recordings.length,
        latestRecordingId: latestRecording?.id ?? null,
        latestRecordingCreatedAt: latestRecording?.createdAt ?? null,
      },
      analyticsSummary: this.buildAnalyticsSummary(rehearsal.metaData),
      ...this.buildVoiceMapSummary(rehearsal.metaData, rehearsal.status),
    };
  }

  async buildList(rows: any[]): Promise<RehearsalReadModel[]> {
    if (rows.length === 0) {
      return [];
    }

    const rehearsalIds = rows.map((row) => row.id);
    const bookingIds = rows
      .map((row) => row.bookingId)
      .filter((id): id is string => Boolean(id));
    const characterIds = rows
      .map((row) => row.characterId)
      .filter((id): id is string => Boolean(id));

    const [bookings, runtimeSessions, recordings, characters] =
      await Promise.all([
        bookingIds.length
          ? this.dataSource.getRepository(Booking).find({
              where: { id: In(bookingIds) },
            })
          : Promise.resolve([]),
        this.dataSource.getRepository(AgoraSession).find({
          where: { rehearsalId: In(rehearsalIds) },
        }),
        this.dataSource.getRepository(Recording).find({
          where: { rehearsalId: In(rehearsalIds) },
        }),
        characterIds.length
          ? this.dataSource.getRepository(Character).find({
              where: { id: In(characterIds) },
            })
          : Promise.resolve([]),
      ]);

    const bookingsById = new Map(
      bookings.map((booking) => [booking.id, booking]),
    );
    const runtimeByRehearsalId = new Map(
      runtimeSessions.map((session) => [session.rehearsalId, session]),
    );
    const characterById = new Map(
      characters.map((character) => [character.id, character]),
    );
    const recordingsByRehearsalId = new Map<string, Recording[]>();
    for (const recording of recordings) {
      if (!recording.rehearsalId) continue;
      const list = recordingsByRehearsalId.get(recording.rehearsalId) ?? [];
      list.push(recording);
      recordingsByRehearsalId.set(recording.rehearsalId, list);
    }

    return rows.map((row) => {
      const recordingList = recordingsByRehearsalId.get(row.id) ?? [];
      const latestRecording = this.getLatestRecording(recordingList);
      const selectedCharacter = row.characterId
        ? (characterById.get(row.characterId) ?? null)
        : null;
      const runtimeSession = runtimeByRehearsalId.get(row.id) ?? null;
      const booking =
        row.bookingId && bookingsById.has(row.bookingId)
          ? bookingsById.get(row.bookingId)!
          : null;
      const setupState = this.buildSetupState(
        row.mode,
        row.runtimeEngine,
        row.status,
        row.projectId,
        row.scriptId,
        row.sceneId,
        null,
        row.characterId,
        [],
      );

      return {
        id: row.id,
        status: row.status,
        mode: row.mode,
        runtimeEngine: row.runtimeEngine,
        startedAt: row.startedAt ? new Date(row.startedAt) : null,
        endedAt: row.endedAt ? new Date(row.endedAt) : null,
        sessionDurationSeconds: row.sessionDurationSeconds ?? null,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
        partner: this.buildPartnerSummary(
          row,
          null,
          row.partnerUserName,
          row.partnerUserEmail,
        ),
        project: row.projectId
          ? { id: row.projectId, title: row.projectTitle ?? null }
          : null,
        script: row.scriptId
          ? { id: row.scriptId, title: row.scriptTitle ?? null }
          : null,
        scene: row.sceneId
          ? {
              id: row.sceneId,
              number: row.sceneNumber ?? null,
              heading: row.sceneHeading ?? null,
            }
          : null,
        booking: booking ? this.buildBookingSummary(booking) : null,
        runtime: runtimeSession
          ? this.buildRuntimeSummary(runtimeSession)
          : null,
        selectedCharacter: selectedCharacter
          ? { id: selectedCharacter.id, name: selectedCharacter.name }
          : row.characterId
            ? { id: row.characterId, name: 'Unknown Character' }
            : null,
        setupState,
        recordingsSummary: {
          count: recordingList.length,
          latestRecordingId: latestRecording?.id ?? null,
          latestRecordingCreatedAt: latestRecording?.createdAt ?? null,
        },
        analyticsSummary: this.buildAnalyticsSummary(row.metaData),
        ...this.buildVoiceMapSummary(row.metaData, row.status),
      };
    });
  }

  private buildPartnerSummary(
    source: {
      rehearsalPartnerType: string;
      rehearsalPartnerUserId?: string | null;
      rehearsalPartnerAiName?: string | null;
      rehearsalPartnerAiDescription?: string | null;
      rehearsalPartnerAiImage?: string | null;
    },
    partnerUser: User | null,
    fallbackUserName?: string | null,
    fallbackUserEmail?: string | null,
  ): RehearsalPartnerSummary {
    const userName = partnerUser?.fullName ?? fallbackUserName ?? null;
    const userEmail = partnerUser?.email ?? fallbackUserEmail ?? null;
    const displayName =
      source.rehearsalPartnerType === 'USER'
        ? (userName ?? userEmail ?? source.rehearsalPartnerUserId ?? null)
        : (source.rehearsalPartnerAiName ?? null);

    return {
      type: source.rehearsalPartnerType,
      displayName,
      userId: source.rehearsalPartnerUserId ?? null,
      userName,
      userEmail,
      aiName: source.rehearsalPartnerAiName ?? null,
      aiDescription: source.rehearsalPartnerAiDescription ?? null,
      aiImage: source.rehearsalPartnerAiImage ?? null,
    };
  }

  private buildBookingSummary(booking: Booking): RehearsalBookingSummary {
    return {
      id: booking.id,
      status: booking.status,
      readerProfileId: booking.readerProfileId,
      sessionStartUtc: booking.sessionStartUtc ?? null,
      sessionEndUtc: booking.sessionEndUtc ?? null,
      sessionDurationMinutes: booking.sessionDurationMinutes,
    };
  }

  private buildRuntimeSummary(session: AgoraSession): RehearsalRuntimeSummary {
    return {
      sessionId: session.id,
      channelName: session.channelName ?? null,
      status: session.status ?? null,
      startedAt: session.startedAt ?? null,
      endedAt: session.endedAt ?? null,
    };
  }

  private buildSetupState(
    mode: string,
    runtimeEngine: string,
    status: string,
    projectId: string | null,
    scriptId: string | null,
    sceneId: string | null,
    scene: Scene | null,
    characterId: string | null,
    availableCharacterIds: string[],
  ): RehearsalSetupStateSummary {
    const hasSceneDialogues = Array.isArray(scene?.dialogues)
      ? scene.dialogues.length > 0
      : Boolean(sceneId);
    const contentReady = Boolean(
      projectId && scriptId && sceneId && hasSceneDialogues,
    );
    const isTeleprompter =
      runtimeEngine === RehearsalRuntimeEngine.TELEPROMPTER;
    const roleSelectionRequired = mode === RehearsalMode.AI;
    // Teleprompter has no role gating — a missing characterId still counts as
    // "selected" because there's nothing to select against.
    const roleSelected = characterId
      ? availableCharacterIds.length > 0
        ? availableCharacterIds.includes(characterId)
        : true
      : isTeleprompter;
    const runtimePrepared = [
      RehearsalStatus.READY,
      RehearsalStatus.ACTIVE,
      RehearsalStatus.PAUSED,
      RehearsalStatus.COMPLETED,
    ].includes(status as RehearsalStatus);

    const missingRequirements: string[] = [];
    if (!contentReady) missingRequirements.push('content_ready');
    if (roleSelectionRequired && !roleSelected)
      missingRequirements.push('role_selected');
    // Teleprompter builds its sequence inline on WS session.start — no
    // prepare step exists, so don't flag runtime_prepared as missing.
    if (!runtimePrepared && !isTeleprompter)
      missingRequirements.push('runtime_prepared');

    return {
      contentReady,
      roleSelectionRequired,
      roleSelected,
      runtimePrepared,
      canPrepareRuntime:
        runtimeEngine === RehearsalRuntimeEngine.HAZEL
          ? contentReady && roleSelected
          : isTeleprompter
            ? false
            : contentReady,
      canStartRuntime:
        runtimeEngine === RehearsalRuntimeEngine.HAZEL
          ? runtimePrepared && roleSelected
          : isTeleprompter
            ? contentReady
            : contentReady,
      selectedCharacterId: characterId && roleSelected ? characterId : null,
      availableCharacterIds,
      missingRequirements,
    };
  }

  private async resolveAvailableCharacterIds(
    scene: Scene | null,
    scriptId: string | null,
  ): Promise<string[]> {
    if (!scene || !scriptId) {
      return [];
    }

    const candidateNames = new Set<string>();
    for (const character of scene.characters ?? []) {
      if (character?.name?.trim()) {
        candidateNames.add(character.name.trim().toLowerCase());
      }
    }
    for (const dialogue of scene.dialogues ?? []) {
      if (dialogue?.characterName?.trim()) {
        candidateNames.add(dialogue.characterName.trim().toLowerCase());
      }
    }

    if (!candidateNames.size) {
      return [];
    }

    const scriptCharacters = await this.dataSource
      .getRepository(Character)
      .find({
        where: { scriptId },
      });

    return scriptCharacters
      .filter((character) =>
        candidateNames.has(character.name.trim().toLowerCase()),
      )
      .map((character) => character.id);
  }

  private buildAnalyticsSummary(
    metaData: Record<string, any> | null | undefined,
  ): RehearsalAnalyticsSummary {
    const normalized =
      typeof metaData === 'string'
        ? this.parseJson(metaData)
        : (metaData ?? null);

    return {
      computedAt: normalized?.analyticsComputedAt ?? null,
      completionPct: normalized?.analytics?.completionPct ?? null,
      avgResponseTimeMs: normalized?.analytics?.avgResponseTimeMs ?? null,
    };
  }

  // Surfaces the persisted voice map (metaData.voiceMap) so the frontend can read
  // it straight off the rehearsal object. `voiceMapFrozen` mirrors the settings
  // service's lock rule (LOCKED_STATUSES) — voices cannot change while playback is
  // ACTIVE/PAUSED. metaData may arrive as a JSON string on the raw-query (list) path.
  private buildVoiceMapSummary(
    metaData: Record<string, any> | null | undefined | string,
    status: string,
  ): { voiceMap: Record<string, string> | null; voiceMapFrozen: boolean } {
    const normalized =
      typeof metaData === 'string'
        ? this.parseJson(metaData)
        : (metaData ?? null);

    return {
      voiceMap:
        (normalized?.voiceMap as Record<string, string> | undefined) ?? null,
      voiceMapFrozen: LOCKED_STATUSES.has(status as RehearsalStatus),
    };
  }

  private getLatestRecording(recordings: Recording[]): Recording | null {
    if (recordings.length === 0) {
      return null;
    }

    return [...recordings].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
  }

  private parseJson(value: string): Record<string, any> | null {
    try {
      return JSON.parse(value) as Record<string, any>;
    } catch {
      return null;
    }
  }
}
