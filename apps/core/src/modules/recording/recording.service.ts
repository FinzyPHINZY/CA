/** biome-ignore-all lint/style/useImportType: <> */

import {
  CdnService,
  Media,
  MediaService,
  ProjectRepository,
  ReaderProfileRepository,
  Recording,
  RecordingMode,
  RecordingRepository,
  RecordingTypeEnum,
  RehersalRepository,
  SceneRepository,
  ScriptRepository,
  UserRepository,
} from '@app/common';
import {
  AgoraTokenService,
  RtcTokenResult,
} from '../studio/agora-token.service';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { CreateRecordingDto } from './dto/create-recording.dto';
import { UpdateRecordingDto } from './dto/update-recording.dto';

@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);

  constructor(
    private readonly recordingRepository: RecordingRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly sceneRepository: SceneRepository,
    private readonly scriptRepository: ScriptRepository,
    private readonly mediaService: MediaService,
    private readonly cdnService: CdnService,
    private readonly dataSource: DataSource,
    private readonly userRepository: UserRepository,
    private readonly readerProfileRepository: ReaderProfileRepository,
    private readonly rehersalRepository: RehersalRepository,
    private readonly agoraTokenService: AgoraTokenService,
  ) {}

  // generate an Agora RTC token for the actor to join the Hazel recording
  // channel. Mirrors the studio token endpoint but skips the AgoraSession DB
  // lookup — Hazel does not back its recordings with AgoraSession rows.
  //
  // The channel name is deterministic (`hazel_rec_{rehearsalId}`) so we don't
  // accept it as input — we derive it from the rehearsalId and validate the
  // caller owns that rehearsal.
  async generateHazelRecordingToken(
    rehearsalId: string,
    userId: string,
  ): Promise<RtcTokenResult> {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal with ID ${rehearsalId} not found`);
    }
    if (rehearsal.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to record this rehearsal',
      );
    }

    const channelName = `hazel_rec_${rehearsalId}`;
    const uid = this.uidFromUuid(userId);
    return this.agoraTokenService.generateRtcToken(
      channelName,
      uid,
      'publisher',
    );
  }

  // deterministic 32-bit unsigned uid from a UUID. Inline copy of the helper
  // in agora-channel.service to avoid cross-module coupling.
  private uidFromUuid(uuid: string): number {
    const hex = uuid.replace(/-/g, '').slice(0, 8);
    return (parseInt(hex, 16) % 2_147_483_647) + 1;
  }

  // create a new recording- validates business rules and handles relationships
  async createRecording(
    userId: string,
    createRecordingDto: CreateRecordingDto,
  ): Promise<any> {
    await this.validateRecordingCreation(userId, createRecordingDto);

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const recordingRepo = manager.getRepository(Recording);

      // extract takes and mediaResources from DTO (they're string arrays, not Media arrays)
      const {
        takes: takesIds,
        mediaResources: mediaResourcesIds,
        ...recordingData
      } = createRecordingDto;

      // create recording entity (without relation arrays)
      const recording = recordingRepo.create({
        ...recordingData,
        userId,
      });

      // handle takes if provided
      if (takesIds && takesIds.length > 0) {
        const takes = await this.validateAndLoadMedia(
          takesIds,
          userId,
          manager,
        );
        recording.takes = takes;
      } else {
        recording.takes = [];
      }

      // handle media resources if provided
      if (mediaResourcesIds && mediaResourcesIds.length > 0) {
        const mediaResources = await this.validateAndLoadMedia(
          mediaResourcesIds,
          userId,
          manager,
        );
        recording.mediaResources = mediaResources;
      } else {
        recording.mediaResources = [];
      }

      const savedRecording = await recordingRepo.save(recording);

      this.logger.log(
        `Recording created: ${savedRecording.id} by user ${userId}`,
      );

      // load full relations for response. userId is a plain UUID (no user
      // relation on this entity — cross-schema decoupling). Clients fetch
      // user details from the auth service via API composition.
      const fullRecording = await recordingRepo.findOne({
        where: { id: savedRecording.id },
        relations: ['project', 'script', 'scene', 'takes', 'mediaResources'],
      });

      if (!fullRecording) {
        throw new NotFoundException(
          `Failed to load created recording ${savedRecording.id}`,
        );
      }

      return {
        success: true,
        message: 'Recording created successfully',
        data: fullRecording,
      };
    });
  }

  // Attach a signed playbackUrl to each take/mediaResource so clients have
  // everything they need to render a player without a follow-up /playback or
  // /variants call. Raw `url` is preserved for backwards compat — clients
  // should prefer `playbackUrl`. Returns a plain object copy — do NOT pass the
  // result back into a repository .save() (loses TypeORM entity prototype).
  private attachPlaybackUrls<
    T extends { takes?: any[]; mediaResources?: any[] },
  >(recording: T): T {
    const sign = (m: any) => ({
      ...m,
      playbackUrl: m?.s3Key ? this.cdnService.generateSignedUrl(m.s3Key) : null,
    });
    return {
      ...recording,
      takes: (recording.takes ?? []).map(sign),
      mediaResources: (recording.mediaResources ?? []).map(sign),
    };
  }

  // find recording by ID — returns the raw entity. Used internally by mutators
  // (updateRecording, deleteRecording, getPlaybackUrl, getVariants) that need
  // a live TypeORM entity. HTTP responses go through getRecordingByIdForResponse.
  async findById(id: string): Promise<any> {
    const recording = await this.recordingRepository.findById(id);

    if (!recording) {
      throw new NotFoundException(`Recording with ID ${id} not found`);
    }

    return {
      success: true,
      message: 'Recording retrieved successfully',
      data: recording,
    };
  }

  // find recording by ID for an HTTP response — decorates takes/mediaResources
  // with signed playbackUrl so the client can render a player from a single
  // request. Don't use internally; this is the client-facing variant.
  async getRecordingByIdForResponse(id: string): Promise<any> {
    const { data: recording } = await this.findById(id);
    return {
      success: true,
      message: 'Recording retrieved successfully',
      data: this.attachPlaybackUrls(recording),
    };
  }

  // find all recordings for a script with pagination
  async findByScriptIdPaginated(
    scriptId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    const script = await this.scriptRepository.findById(scriptId);
    if (!script) {
      throw new NotFoundException(`Script with ID ${scriptId} not found`);
    }

    const {
      data: items,
      total,
      page,
      limit,
    } = await this.recordingRepository.findByScriptIdWithPagination(
      scriptId,
      options,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Recordings retrieved successfully',
      data: {
        items: items.map((r) => this.attachPlaybackUrls(r as any)),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // find all recordings for a project
  async findByProjectId(projectId: string): Promise<Recording[]> {
    // Verify project exists
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    return this.recordingRepository.findByProjectId(projectId);
  }

  // find all recordings for a project with pagination
  async findByProjectIdPaginated(
    projectId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    // verify project exists
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    const {
      data: items,
      total,
      page,
      limit,
    } = await this.recordingRepository.findByProjectIdWithPagination(
      projectId,
      options,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Recordings retrieved successfully',
      data: {
        items: items.map((r) => this.attachPlaybackUrls(r as any)),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // find all recordings for a scene
  async findBySceneId(sceneId: string): Promise<Recording[]> {
    // verify scene exists
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${sceneId} not found`);
    }

    return this.recordingRepository.findBySceneId(sceneId);
  }

  // find all recordings for a scene with pagination
  async findBySceneIdPaginated(
    sceneId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    // verify scene exists
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${sceneId} not found`);
    }

    const {
      data: items,
      total,
      page,
      limit,
    } = await this.recordingRepository.findBySceneIdWithPagination(
      sceneId,
      options,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Recordings retrieved successfully',
      data: {
        items: items.map((r) => this.attachPlaybackUrls(r as any)),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // find all recordings for a rehearsal session with pagination.
  // primary use case: actor reviews takes from a single Hazel/reader session.
  async findByRehearsalIdPaginated(
    rehearsalId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    const rehearsal = await this.rehersalRepository.findById(rehearsalId);
    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal with ID ${rehearsalId} not found`);
    }

    const {
      data: items,
      total,
      page,
      limit,
    } = await this.recordingRepository.findByRehearsalIdWithPagination(
      rehearsalId,
      options,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Recordings retrieved successfully',
      data: {
        items: items.map((r) => this.attachPlaybackUrls(r as any)),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // find all recordings for the authenticated user
  async findByUserId(userId: string): Promise<Recording[]> {
    return this.recordingRepository.findByUserId(userId);
  }

  // find all recordings for the authenticated user with pagination
  async findByUserIdPaginated(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
      type?: string;
      mode?: string;
      status?: string;
    } = {},
  ) {
    const {
      data: items,
      total,
      page,
      limit,
    } = await this.recordingRepository.findByUserIdWithPagination(
      userId,
      options,
    );

    const totalPages = Math.ceil(total / limit);

    const enrichedItems = await this.enrichWithCounterparty(items);
    const itemsWithUrls = enrichedItems.map((r) =>
      this.attachPlaybackUrls(r as any),
    );

    return {
      success: true,
      message: 'Recordings retrieved successfully',
      data: {
        items: itemsWithUrls,
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // For READER/reader_session recordings, attach counterparty details
  // (actor + reader name, avatar, rating, review count). Non-qualifying
  // recordings get counterparty: null so the response shape stays stable.
  private async enrichWithCounterparty(items: Recording[]): Promise<any[]> {
    const qualifiesForCounterparty = (r: Recording): boolean =>
      r.type === RecordingTypeEnum.READER &&
      r.mode === RecordingMode.READER_SESSION &&
      !!r.rehearsal?.booking;

    const qualifying = items.filter(qualifiesForCounterparty);
    if (qualifying.length === 0) {
      return items.map((r) => ({ ...r, counterparty: null }));
    }

    const userIds = new Set<string>();
    const readerUserIds = new Set<string>();
    for (const r of qualifying) {
      const booking = r.rehearsal!.booking!;
      userIds.add(booking.actorUserId);
      userIds.add(booking.readerUserId);
      readerUserIds.add(booking.readerUserId);
    }

    const [users, readerProfiles] = await Promise.all([
      this.userRepository.find({ where: { id: In([...userIds]) } }),
      this.readerProfileRepository.find({
        where: { userId: In([...readerUserIds]) },
      }),
    ]);

    const userById = new Map(users.map((u) => [u.id, u]));
    const readerProfileByUserId = new Map(
      readerProfiles.map((p) => [p.userId, p]),
    );

    return items.map((r) => {
      if (!qualifiesForCounterparty(r)) {
        return { ...r, counterparty: null };
      }
      const booking = r.rehearsal!.booking!;
      const actor = userById.get(booking.actorUserId);
      const reader = userById.get(booking.readerUserId);
      const readerProfile = readerProfileByUserId.get(booking.readerUserId);

      return {
        ...r,
        counterparty: {
          actor: actor
            ? {
                userId: actor.id,
                fullName: actor.fullName ?? null,
                avatar: actor.avatar ?? null,
                avgRating: Number(actor.avgRating ?? 0),
                totalReviews: actor.totalReviews ?? 0,
              }
            : null,
          reader: reader
            ? {
                userId: reader.id,
                fullName: reader.fullName ?? null,
                avatar: reader.avatar ?? null,
                avgRating: Number(readerProfile?.avgRating ?? 0),
                totalReviews: readerProfile?.totalReviews ?? 0,
              }
            : null,
        },
      };
    });
  }

  // find recordings by project and scene
  async findByProjectIdAndSceneId(
    projectId: string,
    sceneId: string,
  ): Promise<Recording[]> {
    // verify project exists
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // verify scene exists
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${sceneId} not found`);
    }

    return this.recordingRepository.findByProjectIdAndSceneId(
      projectId,
      sceneId,
    );
  }

  // find recordings by project and scene with pagination
  async findByProjectIdAndSceneIdPaginated(
    projectId: string,
    sceneId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    // verify project exists
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }

    // verify scene exists
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${sceneId} not found`);
    }

    const {
      data: items,
      total,
      page,
      limit,
    } = await this.recordingRepository.findByProjectIdAndSceneIdWithPagination(
      projectId,
      sceneId,
      options,
    );

    const totalPages = Math.ceil(total / limit);

    return {
      success: true,
      message: 'Recordings retrieved successfully',
      data: {
        items: items.map((r) => this.attachPlaybackUrls(r as any)),
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  // update an existing recording
  async updateRecording(
    id: string,
    userId: string,
    updateRecordingDto: UpdateRecordingDto,
  ): Promise<any> {
    const { data: recording } = await this.findById(id);

    // verify ownership
    if (recording.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to update this recording',
      );
    }

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const recordingRepo = manager.getRepository(Recording);

      // update basic fields
      if (updateRecordingDto.titleCard !== undefined) {
        recording.titleCard = updateRecordingDto.titleCard;
      }
      if (updateRecordingDto.type !== undefined) {
        recording.type = updateRecordingDto.type;
      }
      if (updateRecordingDto.summary !== undefined) {
        recording.summary = updateRecordingDto.summary;
      }
      if (updateRecordingDto.durationMs !== undefined) {
        recording.durationMs = updateRecordingDto.durationMs;
      }
      if (updateRecordingDto.metaData !== undefined) {
        recording.metaData = updateRecordingDto.metaData;
      }

      // handle takes update if provided
      if (updateRecordingDto.takes !== undefined) {
        if (updateRecordingDto.takes.length === 0) {
          recording.takes = [];
        } else {
          const takes = await this.validateAndLoadMedia(
            updateRecordingDto.takes,
            userId,
            manager,
          );
          recording.takes = takes;
        }
      }

      // handle media resources update if provided
      if (updateRecordingDto.mediaResources !== undefined) {
        if (updateRecordingDto.mediaResources.length === 0) {
          recording.mediaResources = [];
        } else {
          const mediaResources = await this.validateAndLoadMedia(
            updateRecordingDto.mediaResources,
            userId,
            manager,
          );
          recording.mediaResources = mediaResources;
        }
      }

      const updatedRecording = await recordingRepo.save(recording);

      this.logger.log(`Recording updated: ${id} by user ${userId}`);

      // load full relations for response. no user relation — userId is a
      // plain UUID, fetch user details from the auth service via API composition.
      const fullRecording = await recordingRepo.findOne({
        where: { id: updatedRecording.id },
        relations: ['project', 'script', 'scene', 'takes', 'mediaResources'],
      });

      if (!fullRecording) {
        throw new NotFoundException(`Failed to load updated recording ${id}`);
      }

      return {
        success: true,
        message: 'Recording updated successfully',
        data: fullRecording,
      };
    });
  }

  // soft deletes the recording so it won't be returned in queries.
  async deleteRecording(id: string, userId: string): Promise<void> {
    const { data: recording } = await this.findById(id);

    // verify ownership
    if (recording.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to delete this recording',
      );
    }

    await this.recordingRepository.softRemoveById(id);

    this.logger.log(`Recording soft deleted: ${id} by user ${userId}`);
  }

  // get a signed playback URL for a recording's primary media.
  // validates that the calling user owns the recording.
  async getPlaybackUrl(recordingId: string, userId: string): Promise<any> {
    const { data: recording } = await this.findById(recordingId);

    if (recording.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access this recording',
      );
    }

    // find the primary media — first take or first media resource
    const primaryMedia = recording.takes?.[0] || recording.mediaResources?.[0];

    if (!primaryMedia || !primaryMedia.s3Key) {
      throw new NotFoundException(
        `No playable media found for recording ${recordingId}`,
      );
    }

    const url = this.cdnService.generateSignedUrl(primaryMedia.s3Key);

    return {
      success: true,
      message: 'Playback URL generated successfully',
      data: {
        url,
        durationMs: recording.durationMs,
        metaData: recording.metaData,
        recording,
      },
    };
  }

  // get all available quality variants for a recording with signed URLs.
  // each take and media resource gets a signed URL.
  async getVariants(recordingId: string, userId: string): Promise<any> {
    const { data: recording } = await this.findById(recordingId);

    if (recording.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access this recording',
      );
    }

    const variants: Array<{
      id: string;
      fileName: string | null;
      contentType: string | null;
      size: number;
      durationMs: number | null;
      url: string;
      type: 'take' | 'resource';
    }> = [];

    for (const take of recording.takes || []) {
      if (take.s3Key) {
        variants.push({
          id: take.id,
          fileName: take.fileName || null,
          contentType: take.contentType || null,
          size: take.size,
          durationMs: take.durationMs ?? null,
          url: this.cdnService.generateSignedUrl(take.s3Key),
          type: 'take',
        });
      }
    }

    for (const resource of recording.mediaResources || []) {
      if (resource.s3Key) {
        variants.push({
          id: resource.id,
          fileName: resource.fileName || null,
          contentType: resource.contentType || null,
          size: resource.size,
          durationMs: resource.durationMs ?? null,
          url: this.cdnService.generateSignedUrl(resource.s3Key),
          type: 'resource',
        });
      }
    }

    return {
      success: true,
      message: 'Recording variants retrieved successfully',
      data: { variants },
    };
  }

  // validate recording creation rules
  private async validateRecordingCreation(
    userId: string,
    dto: CreateRecordingDto,
  ): Promise<void> {
    // verify project exists and belongs to user
    const project = await this.projectRepository.findById(dto.projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${dto.projectId} not found`);
    }
    if (project.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to create recordings for this project',
      );
    }

    // verify scene exists and belongs to the project
    const scene = await this.sceneRepository.findById(dto.sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${dto.sceneId} not found`);
    }

    // verify script exists and belongs to the project
    if (scene.scriptId !== dto.scriptId) {
      throw new BadRequestException(
        'Script ID does not match the scene script',
      );
    }
  }

  // validate and load media entities
  private async validateAndLoadMedia(
    mediaIds: string[],
    userId: string,
    _manager: EntityManager,
  ): Promise<Media[]> {
    const mediaEntities: Media[] = [];

    for (const mediaId of mediaIds) {
      const media = await this.mediaService.findById(mediaId);
      if (media.userId !== userId) {
        throw new ForbiddenException(
          `You are not authorized to use media with ID ${mediaId}`,
        );
      }
      mediaEntities.push(media);
    }

    return mediaEntities;
  }
}
