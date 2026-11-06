import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import {
  RehersalRepository,
  ProjectRepository,
  ScriptRepository,
  SceneRepository,
  CharacterRepository,
  UserRepository,
  RehearsalMode,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  RehearsalEventType,
} from '@app/common';
import { Rehersal, Project, Script, Scene, User } from '@app/common';
import { CreateRehearsalDto } from './dto/create-rehearsal.dto';
import { CreateTeleprompterRehearsalDto } from './dto/create-teleprompter-rehearsal.dto';
import { UpdateRehearsalDto } from './dto/update-rehearsal.dto';
import { ConfigureRehearsalSetupDto } from './dto/configure-rehearsal-setup.dto';
import { RehearsalPartnerType } from '@app/common';
import { DataSource, EntityManager } from 'typeorm';
import { RehearsalReadModelService } from './rehearsal-read-model.service';
import { RehearsalLifecycleEventService } from './rehearsal-lifecycle-event.service';

/**
 * Service responsible for rehearsal business logic
 * Follows Single Responsibility Principle - handles only rehearsal-related operations
 */
@Injectable()
export class RehearsalService {
  private readonly logger = new Logger(RehearsalService.name);

  constructor(
    private readonly rehearsalRepository: RehersalRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly scriptRepository: ScriptRepository,
    private readonly sceneRepository: SceneRepository,
    private readonly characterRepository: CharacterRepository,
    private readonly userRepository: UserRepository,
    private readonly dataSource: DataSource,
    private readonly rehearsalReadModelService: RehearsalReadModelService,
    private readonly rehearsalLifecycleEventService: RehearsalLifecycleEventService,
  ) {}

  /**
   * Create a new rehearsal
   * Validates business rules and handles relationships
   * Automatically derives scriptId and projectId from the scene
   */
  async createRehearsal(
    userId: string,
    createRehearsalDto: CreateRehearsalDto,
  ): Promise<any> {
    // Get scene first to derive scriptId and projectId
    const scene = await this.sceneRepository.findById(
      createRehearsalDto.sceneId,
    );
    if (!scene) {
      throw new NotFoundException(
        `Scene with ID ${createRehearsalDto.sceneId} not found`,
      );
    }

    // Get script to derive projectId
    const script = await this.scriptRepository.findById(scene.scriptId);
    if (!script) {
      throw new NotFoundException(`Script with ID ${scene.scriptId} not found`);
    }

    // Create DTO with derived values for validation
    const validationDto = {
      ...createRehearsalDto,
      scriptId: scene.scriptId,
      projectId: script.projectId,
    };

    await this.validateRehearsalCreation(userId, validationDto);

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const rehearsalRepo = manager.getRepository(Rehersal);

      // Prepare rehearsal data based on partner type
      const rehearsalData: Partial<Rehersal> = {
        userId,
        projectId: script.projectId, // Derived from scene -> script
        scriptId: scene.scriptId, // Derived from scene
        sceneId: createRehearsalDto.sceneId,
        rehearsalPartnerType: createRehearsalDto.rehearsalPartnerType,
        status: RehearsalStatus.CREATED,
        mode:
          createRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI
            ? RehearsalMode.AI
            : RehearsalMode.USER_DIRECT,
        runtimeEngine:
          createRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI
            ? RehearsalRuntimeEngine.HAZEL
            : RehearsalRuntimeEngine.NONE,
        bookingId: null,
        characterId: null,
        metaData: {
          setup: {
            characterSelectionRequired:
              createRehearsalDto.rehearsalPartnerType ===
              RehearsalPartnerType.AI,
            characterSelected: false,
          },
        },
      };

      // Set partner-specific fields
      if (
        createRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.USER
      ) {
        rehearsalData.rehearsalPartnerUserId =
          createRehearsalDto.rehearsalPartnerUserId;
        rehearsalData.rehearsalPartnerAiName = null;
        rehearsalData.rehearsalPartnerAiDescription = null;
        rehearsalData.rehearsalPartnerAiImage = null;
      } else if (
        createRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI
      ) {
        rehearsalData.rehearsalPartnerUserId = null;
        rehearsalData.rehearsalPartnerAiName =
          createRehearsalDto.rehearsalPartnerAiName || null;
        rehearsalData.rehearsalPartnerAiDescription =
          createRehearsalDto.rehearsalPartnerAiDescription || null;
        rehearsalData.rehearsalPartnerAiImage =
          createRehearsalDto.rehearsalPartnerAiImage || null;
      }

      const rehearsal = rehearsalRepo.create(rehearsalData);
      const savedRehearsal = await rehearsalRepo.save(rehearsal);
      await this.rehearsalLifecycleEventService.log(
        savedRehearsal.id,
        RehearsalEventType.SESSION_CREATED,
        {
          manager,
          data: {
            mode: savedRehearsal.mode,
            runtimeEngine: savedRehearsal.runtimeEngine,
            partnerType: savedRehearsal.rehearsalPartnerType,
          },
        },
      );

      this.logger.log(
        `Rehearsal created: ${savedRehearsal.id} by user ${userId}`,
      );

      // Load full relations for response
      const fullRehearsal = await rehearsalRepo.findOne({
        where: { id: savedRehearsal.id },
        relations: ['project', 'script', 'scene', 'recordings', 'character'],
      });

      if (!fullRehearsal) {
        throw new NotFoundException(
          `Rehearsal with ID ${savedRehearsal.id} not found after creation`,
        );
      }

      return {
        success: true,
        message: 'Rehearsal created successfully',
        data: await this.rehearsalReadModelService.buildDetail(fullRehearsal),
      };
    });
  }

  /**
   * Create a SOLO/TELEPROMPTER rehearsal. No partner, no role gating. The
   * teleprompter cue engine is speaker-agnostic — `characterId` is stored
   * as display-only metadata. Sequence is built inline on the WS
   * `session.start` event; there is no `prepare` step.
   */
  async createTeleprompter(
    userId: string,
    dto: CreateTeleprompterRehearsalDto,
  ): Promise<any> {
    const scene = await this.sceneRepository.findById(dto.sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${dto.sceneId} not found`);
    }

    const script = await this.scriptRepository.findById(scene.scriptId);
    if (!script) {
      throw new NotFoundException(`Script with ID ${scene.scriptId} not found`);
    }
    if (script.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to create a rehearsal for script ${scene.scriptId}`,
      );
    }

    if (dto.characterId) {
      const character = await this.characterRepository.findById(dto.characterId);
      if (!character) {
        throw new NotFoundException(
          `Character with ID ${dto.characterId} not found`,
        );
      }
      if (character.scriptId !== scene.scriptId) {
        throw new BadRequestException(
          `Character ${dto.characterId} does not belong to scene ${dto.sceneId}'s script`,
        );
      }
    }

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const rehearsalRepo = manager.getRepository(Rehersal);

      const rehearsal = rehearsalRepo.create({
        userId,
        projectId: script.projectId,
        scriptId: scene.scriptId,
        sceneId: dto.sceneId,
        characterId: dto.characterId ?? null,
        rehearsalPartnerType: null,
        rehearsalPartnerUserId: null,
        rehearsalPartnerAiName: null,
        rehearsalPartnerAiDescription: null,
        rehearsalPartnerAiImage: null,
        bookingId: null,
        status: RehearsalStatus.CREATED,
        mode: RehearsalMode.SOLO,
        runtimeEngine: RehearsalRuntimeEngine.TELEPROMPTER,
        metaData: {
          setup: {
            characterSelectionRequired: false,
            characterSelected: !!dto.characterId,
          },
        },
      });

      const savedRehearsal = await rehearsalRepo.save(rehearsal);
      await this.rehearsalLifecycleEventService.log(
        savedRehearsal.id,
        RehearsalEventType.SESSION_CREATED,
        {
          manager,
          data: {
            mode: savedRehearsal.mode,
            runtimeEngine: savedRehearsal.runtimeEngine,
            partnerType: null,
          },
        },
      );

      this.logger.log(
        `Teleprompter rehearsal created: ${savedRehearsal.id} by user ${userId}`,
      );

      const fullRehearsal = await rehearsalRepo.findOne({
        where: { id: savedRehearsal.id },
        relations: ['project', 'script', 'scene', 'recordings', 'character'],
      });

      if (!fullRehearsal) {
        throw new NotFoundException(
          `Rehearsal with ID ${savedRehearsal.id} not found after creation`,
        );
      }

      return {
        success: true,
        message: 'Teleprompter rehearsal created successfully',
        data: await this.rehearsalReadModelService.buildDetail(fullRehearsal),
      };
    });
  }

  /**
   * Find rehearsal by ID with all relations
   */
  async findById(id: string, userId: string): Promise<any> {
    const rehearsal = await this.loadRehearsalEntity(id);
    if (rehearsal.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to view this rehearsal',
      );
    }
    return this.rehearsalReadModelService.buildDetail(rehearsal);
  }

  /**
   * Find rehearsals by user ID with pagination, search, sort, and filter
   */
  async findByUserIdPaginated(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      partnerType?: RehearsalPartnerType;
      sortBy?: 'createdAt' | 'updatedAt';
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const paginationResult =
      await this.rehearsalRepository.findByUserIdWithPagination(
        userId,
        options,
      );
    const items = await Promise.all(
      paginationResult.data.map((rehearsal) =>
        this.rehearsalReadModelService.buildDetail(rehearsal),
      ),
    );

    const totalPages = Math.ceil(
      paginationResult.total / paginationResult.limit,
    );
    const hasNext = paginationResult.page < totalPages;
    const hasPrev = paginationResult.page > 1;

    return {
      success: true,
      message: 'Rehearsals retrieved successfully',
      data: {
        items,
        total: paginationResult.total,
        page: paginationResult.page,
        limit: paginationResult.limit,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
  }

  /**
   * Find rehearsals by project ID with pagination, search, sort, and filter
   */
  async findByProjectIdPaginated(
    projectId: string,
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      partnerType?: RehearsalPartnerType;
      sortBy?: 'createdAt' | 'updatedAt';
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${projectId} not found`);
    }
    if (project.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to view rehearsals for project ${projectId}`,
      );
    }

    const paginationResult =
      await this.rehearsalRepository.findByProjectIdWithPagination(
        projectId,
        options,
      );
    const items = await Promise.all(
      paginationResult.data.map((rehearsal) =>
        this.rehearsalReadModelService.buildDetail(rehearsal),
      ),
    );

    const totalPages = Math.ceil(
      paginationResult.total / paginationResult.limit,
    );
    const hasNext = paginationResult.page < totalPages;
    const hasPrev = paginationResult.page > 1;

    return {
      success: true,
      message: 'Rehearsals retrieved successfully',
      data: {
        items,
        total: paginationResult.total,
        page: paginationResult.page,
        limit: paginationResult.limit,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
  }

  /**
   * Find rehearsals by script ID with pagination, search, sort, and filter
   */
  async findByScriptIdPaginated(
    scriptId: string,
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      partnerType?: RehearsalPartnerType;
      sortBy?: 'createdAt' | 'updatedAt';
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const script = await this.scriptRepository.findById(scriptId);
    if (!script) {
      throw new NotFoundException(`Script with ID ${scriptId} not found`);
    }
    if (script.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to view rehearsals for script ${scriptId}`,
      );
    }

    const paginationResult =
      await this.rehearsalRepository.findByScriptIdWithPagination(
        scriptId,
        options,
      );
    const items = await Promise.all(
      paginationResult.data.map((rehearsal) =>
        this.rehearsalReadModelService.buildDetail(rehearsal),
      ),
    );

    const totalPages = Math.ceil(
      paginationResult.total / paginationResult.limit,
    );
    const hasNext = paginationResult.page < totalPages;
    const hasPrev = paginationResult.page > 1;

    return {
      success: true,
      message: 'Rehearsals retrieved successfully',
      data: {
        items,
        total: paginationResult.total,
        page: paginationResult.page,
        limit: paginationResult.limit,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
  }

  /**
   * Find rehearsals by scene ID with pagination, search, sort, and filter
   */
  async findBySceneIdPaginated(
    sceneId: string,
    userId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      partnerType?: RehearsalPartnerType;
      sortBy?: 'createdAt' | 'updatedAt';
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const scene = await this.sceneRepository.findById(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${sceneId} not found`);
    }
    const script = await this.scriptRepository.findById(scene.scriptId);
    if (!script || script.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to view rehearsals for scene ${sceneId}`,
      );
    }

    const paginationResult =
      await this.rehearsalRepository.findBySceneIdWithPagination(
        sceneId,
        options,
      );
    const items = await Promise.all(
      paginationResult.data.map((rehearsal) =>
        this.rehearsalReadModelService.buildDetail(rehearsal),
      ),
    );

    const totalPages = Math.ceil(
      paginationResult.total / paginationResult.limit,
    );
    const hasNext = paginationResult.page < totalPages;
    const hasPrev = paginationResult.page > 1;

    return {
      success: true,
      message: 'Rehearsals retrieved successfully',
      data: {
        items,
        total: paginationResult.total,
        page: paginationResult.page,
        limit: paginationResult.limit,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
  }

  /**
   * Update rehearsal
   */
  async updateRehearsal(
    id: string,
    userId: string,
    updateRehearsalDto: UpdateRehearsalDto,
  ): Promise<any> {
    const rehearsal = await this.loadRehearsalEntity(id);

    // Verify ownership
    if (rehearsal.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to update this rehearsal',
      );
    }

    return this.dataSource.transaction(async (manager: EntityManager) => {
      const rehearsalRepo = manager.getRepository(Rehersal);

      // Prepare update data
      const updateData: Partial<Rehersal> = {};
      let nextSetup = rehearsal.metaData?.setup ?? {};

      // If partner type is being updated, handle partner-specific fields
      if (updateRehearsalDto.rehearsalPartnerType !== undefined) {
        updateData.rehearsalPartnerType =
          updateRehearsalDto.rehearsalPartnerType;
        updateData.mode =
          updateRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI
            ? RehearsalMode.AI
            : RehearsalMode.USER_DIRECT;
        updateData.runtimeEngine =
          updateRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI
            ? RehearsalRuntimeEngine.HAZEL
            : RehearsalRuntimeEngine.NONE;
        nextSetup = {
          ...nextSetup,
          characterSelectionRequired:
            updateRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI,
        };

        if (
          updateRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.USER
        ) {
          updateData.rehearsalPartnerUserId =
            updateRehearsalDto.rehearsalPartnerUserId || null;
          updateData.rehearsalPartnerAiName = null;
          updateData.rehearsalPartnerAiDescription = null;
          updateData.rehearsalPartnerAiImage = null;
        } else if (
          updateRehearsalDto.rehearsalPartnerType === RehearsalPartnerType.AI
        ) {
          updateData.rehearsalPartnerUserId = null;
          updateData.rehearsalPartnerAiName =
            updateRehearsalDto.rehearsalPartnerAiName || null;
          updateData.rehearsalPartnerAiDescription =
            updateRehearsalDto.rehearsalPartnerAiDescription || null;
          updateData.rehearsalPartnerAiImage =
            updateRehearsalDto.rehearsalPartnerAiImage || null;
        }
      } else {
        // Update individual partner fields if provided
        if (updateRehearsalDto.rehearsalPartnerUserId !== undefined) {
          updateData.rehearsalPartnerUserId =
            updateRehearsalDto.rehearsalPartnerUserId;
        }
        if (updateRehearsalDto.rehearsalPartnerAiName !== undefined) {
          updateData.rehearsalPartnerAiName =
            updateRehearsalDto.rehearsalPartnerAiName;
        }
        if (updateRehearsalDto.rehearsalPartnerAiDescription !== undefined) {
          updateData.rehearsalPartnerAiDescription =
            updateRehearsalDto.rehearsalPartnerAiDescription;
        }
        if (updateRehearsalDto.rehearsalPartnerAiImage !== undefined) {
          updateData.rehearsalPartnerAiImage =
            updateRehearsalDto.rehearsalPartnerAiImage;
        }
      }

      updateData.metaData = this.mergeMetaData(rehearsal.metaData, {
        setup: nextSetup,
      });

      await rehearsalRepo.update(id, updateData);

      this.logger.log(`Rehearsal updated: ${id} by user ${userId}`);

      // Reload with relations
      const updatedRehearsal = await rehearsalRepo.findOne({
        where: { id },
        relations: ['project', 'script', 'scene', 'recordings', 'character'],
      });

      if (!updatedRehearsal) {
        throw new NotFoundException(
          `Rehearsal with ID ${id} not found after update`,
        );
      }

      return {
        success: true,
        message: 'Rehearsal updated successfully',
        data: await this.rehearsalReadModelService.buildDetail(
          updatedRehearsal,
        ),
      };
    });
  }

  async configureSetup(
    id: string,
    userId: string,
    dto: ConfigureRehearsalSetupDto,
  ): Promise<any> {
    const rehearsal = await this.rehearsalRepository.findOne({
      where: { id },
      relations: ['project', 'script', 'scene', 'recordings'],
      withDeleted: false,
    });

    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal with ID ${id} not found`);
    }

    if (rehearsal.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to configure this rehearsal',
      );
    }

    if (
      rehearsal.status === RehearsalStatus.PREPARING ||
      rehearsal.status === RehearsalStatus.READY ||
      rehearsal.status === RehearsalStatus.ACTIVE ||
      rehearsal.status === RehearsalStatus.PAUSED
    ) {
      throw new BadRequestException(
        'Cannot change rehearsal setup while runtime preparation or playback is in progress',
      );
    }

    if (!rehearsal.sceneId) {
      throw new BadRequestException(
        'This rehearsal does not have a linked scene yet',
      );
    }

    const scene = await this.sceneRepository.findByIdWithCharacters(
      rehearsal.sceneId,
    );
    if (!scene) {
      throw new NotFoundException(
        `Scene with ID ${rehearsal.sceneId} not found`,
      );
    }

    const readiness = (
      await this.rehearsalReadModelService.buildDetail({
        ...rehearsal,
        scene,
        character: null,
        characterId: null,
      } as Rehersal)
    ).setupState;
    if (!readiness.contentReady) {
      throw new BadRequestException(
        'Rehearsal content is not ready yet. Complete script analysis before selecting a role.',
      );
    }

    const canonicalCharacter = await this.resolveRequestedSceneCharacter(
      rehearsal.scriptId ?? scene.scriptId,
      scene,
      dto.characterId,
    );
    if (!canonicalCharacter) {
      throw new BadRequestException(
        `Character ${dto.characterId} is not available in this rehearsal scene. Refresh scene data and try again.`,
      );
    }

    try {
      await this.rehearsalRepository.updateById(id, {
        characterId: canonicalCharacter.id,
        metaData: this.mergeMetaData(rehearsal.metaData, {
          setup: {
            characterSelectionRequired: rehearsal.mode === RehearsalMode.AI,
            characterSelected: true,
            configuredAt: new Date().toISOString(),
          },
        }),
      });
    } catch (error: any) {
      if (this.isCharacterForeignKeyViolation(error)) {
        throw new BadRequestException(
          `Character ${dto.characterId} is no longer available for this rehearsal script. Refresh scene data and try again.`,
        );
      }
      throw error;
    }

    const updated = await this.rehearsalRepository.findOne({
      where: { id },
      relations: ['project', 'script', 'scene', 'recordings'],
      withDeleted: false,
    });

    if (!updated) {
      throw new NotFoundException(
        `Rehearsal with ID ${id} not found after setup`,
      );
    }

    return {
      success: true,
      message: 'Rehearsal setup updated successfully',
      data: await this.rehearsalReadModelService.buildDetail(updated),
    };
  }

  private async resolveCanonicalSceneCharacter(
    scriptId: string | null | undefined,
    characterId: string,
    characterName: string | null | undefined,
  ) {
    const directMatch = await this.characterRepository.findById(characterId);
    if (directMatch && (!scriptId || directMatch.scriptId === scriptId)) {
      return directMatch;
    }

    if (!scriptId || !characterName) {
      return null;
    }

    return this.characterRepository.findByScriptIdAndName(
      scriptId,
      characterName,
    );
  }

  private async resolveRequestedSceneCharacter(
    scriptId: string | null | undefined,
    scene: Scene,
    requestedCharacterId: string,
  ) {
    const directMatch =
      await this.characterRepository.findById(requestedCharacterId);
    if (
      directMatch &&
      (!scriptId || directMatch.scriptId === scriptId) &&
      this.sceneContainsCharacter(scene, directMatch)
    ) {
      return directMatch;
    }

    const selectedSceneCharacter =
      scene.characters?.find(
        (character) => character.id === requestedCharacterId,
      ) ?? null;
    if (selectedSceneCharacter) {
      return this.resolveCanonicalSceneCharacter(
        scriptId ?? scene.scriptId,
        selectedSceneCharacter.id,
        selectedSceneCharacter.name,
      );
    }

    const dialogueCharacterName =
      scene.dialogues?.find(
        (dialogue) =>
          dialogue.characterId === requestedCharacterId &&
          dialogue.characterName,
      )?.characterName ?? null;
    if (dialogueCharacterName) {
      return this.characterRepository.findByScriptIdAndName(
        scriptId ?? scene.scriptId,
        dialogueCharacterName,
      );
    }

    return null;
  }

  private sceneContainsCharacter(
    scene: Scene,
    character: { id: string; name: string },
  ) {
    const inSceneCharacters = Boolean(
      scene.characters?.some(
        (sceneCharacter) =>
          sceneCharacter.id === character.id ||
          sceneCharacter.name.toLowerCase() === character.name.toLowerCase(),
      ),
    );
    if (inSceneCharacters) {
      return true;
    }

    return Boolean(
      scene.dialogues?.some(
        (dialogue) =>
          dialogue.characterId === character.id ||
          (dialogue.characterName &&
            dialogue.characterName.toLowerCase() ===
              character.name.toLowerCase()),
      ),
    );
  }

  private isCharacterForeignKeyViolation(error: any) {
    return (
      error?.code === '23503' &&
      typeof error?.message === 'string' &&
      error.message.includes('FK_rehersals_characterId')
    );
  }

  /**
   * Soft delete rehearsal
   * Soft deletes the rehearsal so it won't be returned in queries.
   */
  async deleteRehearsal(id: string, userId: string): Promise<void> {
    const rehearsal = await this.loadRehearsalEntity(id);

    // Verify ownership
    if (rehearsal.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to delete this rehearsal',
      );
    }

    await this.rehearsalRepository.deleteRehearsal(id);

    this.logger.log(`Rehearsal soft deleted: ${id} by user ${userId}`);
  }

  /**
   * Validate rehearsal creation rules
   * Single Responsibility: Only validates business rules
   * Note: scriptId and projectId are derived from the scene, so they're passed in the validation DTO
   */
  private async validateRehearsalCreation(
    userId: string,
    dto: CreateRehearsalDto & { scriptId: string; projectId: string },
  ): Promise<void> {
    // Validate project exists and belongs to user
    const project = await this.projectRepository.findById(dto.projectId);
    if (!project) {
      throw new NotFoundException(`Project with ID ${dto.projectId} not found`);
    }
    if (project.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to create a rehearsal for project ${dto.projectId}`,
      );
    }

    // Validate script exists and belongs to user
    const script = await this.scriptRepository.findById(dto.scriptId);
    if (!script) {
      throw new NotFoundException(`Script with ID ${dto.scriptId} not found`);
    }
    if (script.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to create a rehearsal for script ${dto.scriptId}`,
      );
    }

    // Validate scene exists and belongs to the script
    const scene = await this.sceneRepository.findById(dto.sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${dto.sceneId} not found`);
    }
    if (scene.scriptId !== dto.scriptId) {
      throw new BadRequestException(
        `Scene ${dto.sceneId} does not belong to script ${dto.scriptId}`,
      );
    }

    // Validate script belongs to project
    if (script.projectId !== dto.projectId) {
      throw new BadRequestException(
        `Script ${dto.scriptId} does not belong to project ${dto.projectId}`,
      );
    }

    // Validate partner-specific requirements
    if (dto.rehearsalPartnerType === RehearsalPartnerType.USER) {
      if (!dto.rehearsalPartnerUserId) {
        throw new BadRequestException(
          'Rehearsal partner user ID is required when partner type is USER',
        );
      }

      // Validate partner user exists
      const partnerUser = await this.userRepository.findById(
        dto.rehearsalPartnerUserId,
      );
      if (!partnerUser) {
        throw new NotFoundException(
          `Partner user with ID ${dto.rehearsalPartnerUserId} not found`,
        );
      }

      // User cannot be their own partner
      if (dto.rehearsalPartnerUserId === userId) {
        throw new BadRequestException(
          'You cannot be your own rehearsal partner',
        );
      }
    } else if (dto.rehearsalPartnerType === RehearsalPartnerType.AI) {
      if (!dto.rehearsalPartnerAiName) {
        throw new BadRequestException(
          'AI partner name is required when partner type is AI',
        );
      }
    }
  }

  private mergeMetaData(
    current: Record<string, any> | null,
    patch: Record<string, any>,
  ): Record<string, any> {
    return {
      ...(current ?? {}),
      ...patch,
      setup: {
        ...(current?.setup ?? {}),
        ...(patch.setup ?? {}),
      },
    };
  }

  private async loadRehearsalEntity(id: string): Promise<Rehersal> {
    const rehearsal = await this.rehearsalRepository.findOne({
      where: { id },
      relations: ['project', 'script', 'scene', 'recordings', 'character'],
      withDeleted: false,
    });

    if (!rehearsal) {
      throw new NotFoundException(`Rehearsal with ID ${id} not found`);
    }

    return rehearsal;
  }
}
