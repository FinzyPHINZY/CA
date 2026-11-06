import {
  Script,
  ScriptRepository,
  ScriptStatus,
  SceneRepository,
  CharacterRepository,
  RecordingRepository,
  RehersalRepository,
} from '@app/common';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateScriptDto } from './dto/create-script.dto';
import { buildScriptAnalysisLifecycleSummary } from './script-analysis-lifecycle.util';

@Injectable()
export class ScriptService {
  constructor(
    private readonly scriptRepository: ScriptRepository,
    private readonly sceneRepository: SceneRepository,
    private readonly characterRepository: CharacterRepository,
    private readonly recordingRepository: RecordingRepository,
    private readonly rehersalRepository: RehersalRepository,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Find script by ID with statistics (scenes, characters, recordings, rehearsals)
   */
  async findById(id: string): Promise<any> {
    const script = await this.scriptRepository.findOne({
      where: { id },
      withDeleted: false, // Explicitly exclude soft-deleted scripts
    });
    if (!script) {
      throw new NotFoundException(`Script with ID ${id} not found`);
    }

    // Fetch statistics in parallel for better performance
    const [sceneCount, characterCount, totalRecordings, totalRehersals] =
      await Promise.all([
        this.sceneRepository.countByScriptId(script.id),
        this.characterRepository.countByScriptId(script.id),
        this.recordingRepository.countByScriptId(script.id),
        this.rehersalRepository.countByScriptId(script.id),
      ]);

    return {
      success: true,
      message: 'Script retrieved successfully',
      data: {
        ...script,
        analysisLifecycle: buildScriptAnalysisLifecycleSummary(script),
        sceneCount,
        characterCount,
        totalRecordings,
        totalRehersals,
      },
    };
  }

  async findByAuthorId(authorId: string): Promise<Script[]> {
    return this.scriptRepository.findByAuthorId(authorId);
  }

  /**
   * Find scripts by author ID with pagination and statistics
   * Returns scripts enriched with scene, character, recording, and rehearsal counts
   */
  async findByAuthorIdPaginated(
    authorId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: ScriptStatus;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const { data, total, page, limit } =
      await this.scriptRepository.findByAuthorIdWithPagination(
        authorId,
        options,
      );

    // Enrich each script with statistics
    const scriptsWithStats = await Promise.all(
      data.map(async (script) => {
        const [sceneCount, characterCount, totalRecordings, totalRehersals] =
          await Promise.all([
            this.sceneRepository.countByScriptId(script.id),
            this.characterRepository.countByScriptId(script.id),
            this.recordingRepository.countByScriptId(script.id),
            this.rehersalRepository.countByScriptId(script.id),
          ]);

        return {
          ...script,
          analysisLifecycle: buildScriptAnalysisLifecycleSummary(script),
          sceneCount,
          characterCount,
          totalRecordings,
          totalRehersals,
        };
      }),
    );

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      message: 'Scripts retrieved successfully',
      data: {
        items: scriptsWithStats,
        total,
        page,
        limit,
        totalPages,
        hasNext,
        hasPrev,
      },
    };
  }

  async create(scriptData: Partial<Script>): Promise<any> {
    return this.createForUser(
      scriptData.userId!,
      scriptData as CreateScriptDto,
    );
  }

  async createForUser(
    userId: string,
    scriptData: CreateScriptDto,
  ): Promise<any> {
    const script = this.scriptRepository.create({
      ...scriptData,
      userId,
      status: ScriptStatus.UPLOADED,
    });
    const saved = await this.scriptRepository.save(script);
    return {
      success: true,
      message: 'Script created successfully',
      data: saved,
    };
  }

  async updateStatusForUser(
    userId: string,
    id: string,
    status: ScriptStatus,
  ): Promise<any> {
    await this.ensureScriptOwnership(userId, id);
    await this.scriptRepository.update(id, { status });
    const { data: script } = await this.findById(id);
    return {
      success: true,
      message: 'Script status updated successfully',
      data: script,
    };
  }

  async updateForUser(
    userId: string,
    id: string,
    scriptData: Partial<Script>,
  ): Promise<any> {
    await this.ensureScriptOwnership(userId, id);

    if (scriptData.projectId !== undefined) {
      throw new BadRequestException(
        'projectId cannot be updated through /api/scripts. Use project-scoped endpoints instead.',
      );
    }
    if (scriptData.userId !== undefined) {
      throw new BadRequestException('userId cannot be updated');
    }
    if (scriptData.taskId !== undefined) {
      throw new BadRequestException('taskId cannot be updated');
    }
    if (scriptData.sourceMediaId !== undefined) {
      throw new BadRequestException('sourceMediaId cannot be updated');
    }

    // Validate and normalize status if provided
    if (scriptData.status !== undefined) {
      // Map common invalid status values to valid ones
      const statusMapping: Record<string, ScriptStatus> = {
        completed: ScriptStatus.ANALYZED,
        complete: ScriptStatus.ANALYZED,
        done: ScriptStatus.ANALYZED,
        finished: ScriptStatus.ANALYZED,
        success: ScriptStatus.ANALYZED,
        error: ScriptStatus.FAILED,
        errored: ScriptStatus.FAILED,
      };

      // Convert status to string for comparison (handles both enum and string inputs)
      const statusStr = String(scriptData.status).toLowerCase();
      const normalizedStatus = statusMapping[statusStr] || scriptData.status;

      // Validate that the status is a valid enum value
      if (
        !Object.values(ScriptStatus).includes(normalizedStatus as ScriptStatus)
      ) {
        throw new BadRequestException(
          `Invalid script status: "${scriptData.status}". Valid values are: ${Object.values(ScriptStatus).join(', ')}`,
        );
      }

      scriptData.status = normalizedStatus as ScriptStatus;
    }

    await this.scriptRepository.update(id, scriptData);
    const { data: script } = await this.findById(id);
    return {
      success: true,
      message: 'Script updated successfully',
      data: script,
    };
  }

  /**
   * Soft delete script
   * Soft deletes the script so it won't be returned in queries.
   */
  async deleteForUser(userId: string, id: string): Promise<void> {
    await this.ensureScriptOwnership(userId, id);

    // Verify script exists without loading statistics (to avoid potential errors during deletion)
    const script = await this.scriptRepository.findOne({
      where: { id },
      withDeleted: false, // Explicitly exclude soft-deleted scripts
    });

    if (!script) {
      throw new NotFoundException(`Script with ID ${id} not found`);
    }

    await this.scriptRepository.deleteScript(id);
  }

  async findByIdForUser(userId: string, id: string): Promise<any> {
    await this.ensureScriptOwnership(userId, id);
    return this.findById(id);
  }

  async findByAuthorIdPaginatedForUser(
    userId: string,
    authorId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      status?: ScriptStatus;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    if (userId !== authorId) {
      throw new ForbiddenException('You may only list your own scripts');
    }
    return this.findByAuthorIdPaginated(authorId, options);
  }

  private async ensureScriptOwnership(
    userId: string,
    scriptId: string,
  ): Promise<Script> {
    const script = await this.scriptRepository.findOne({
      where: { id: scriptId },
      withDeleted: false,
    });
    if (!script) {
      throw new NotFoundException(`Script with ID ${scriptId} not found`);
    }
    if (script.userId !== userId) {
      throw new ForbiddenException(
        `You are not authorized to access script ${scriptId}`,
      );
    }
    return script;
  }
}
