import { Injectable, NotFoundException } from '@nestjs/common';
import { Scene, SceneRepository, ScriptRepository } from '@app/common';
// import { AnalysisService } from '../analysis/analysis.service';

@Injectable()
export class SceneService {
  constructor(
    private readonly sceneRepository: SceneRepository,
    private readonly scriptRepository: ScriptRepository,
    // private readonly analysisService: AnalysisService,
  ) {}

  async getScenesByScriptId(scriptId: string): Promise<any[]> {
    // Prefer normalized scenes with characters and pages; fallback to analysis JSON if present
    const scenes =
      await this.sceneRepository.findByScriptIdWithCharacters(scriptId);
    if (scenes.length > 0) {
      return scenes;
    }
    // const analysis = await this.analysisService.findByScriptId(scriptId);
    // return (analysis as any)?.scenes || [];
    return [];
  }

  async getScenesByScriptIdPaginated(
    scriptId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    const { data, total, page, limit } =
      await this.sceneRepository.findByScriptIdWithPagination(
        scriptId,
        options,
      );

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      message: 'Scenes retrieved successfully',
      data: { items: data, total, page, limit, totalPages, hasNext, hasPrev },
    };
  }

  async findById(id: string): Promise<Scene | null> {
    return this.sceneRepository.findById(id);
  }

  /**
   * Get scene by ID with characters loaded
   * Throws NotFoundException if scene doesn't exist
   */
  async getSceneById(id: string): Promise<any> {
    const scene = await this.sceneRepository.findByIdWithCharacters(id);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${id} not found`);
    }
    return {
      success: true,
      message: 'Scene retrieved successfully',
      data: scene,
    };
  }

  async findByScriptId(scriptId: string): Promise<Scene[]> {
    return this.sceneRepository.findByScriptId(scriptId);
  }

  async findByScriptIdWithCharacters(scriptId: string): Promise<Scene[]> {
    return this.sceneRepository.findByScriptIdWithCharacters(scriptId);
  }

  async findByScriptIdAndNumber(
    scriptId: string,
    number: number,
  ): Promise<Scene | null> {
    return this.sceneRepository.findByScriptIdAndNumber(scriptId, number);
  }

  async create(sceneData: Partial<Scene>): Promise<Scene> {
    return this.sceneRepository.createScene(sceneData);
  }

  async createMany(scenesData: Partial<Scene>[]): Promise<Scene[]> {
    return this.sceneRepository.createScenes(scenesData);
  }

  async update(id: string, sceneData: Partial<Scene>): Promise<Scene | null> {
    return this.sceneRepository.updateScene(id, sceneData);
  }

  /**
   * Soft delete scene
   * Soft deletes the scene so it won't be returned in queries.
   */
  async delete(id: string): Promise<void> {
    await this.findById(id); // Verify scene exists (will throw if not found or already soft-deleted)
    await this.sceneRepository.deleteScene(id);
  }

  /**
   * Soft delete all scenes for a script
   * Soft deletes all scenes so they won't be returned in queries.
   */
  async deleteByScriptId(scriptId: string): Promise<void> {
    await this.sceneRepository.deleteByScriptId(scriptId);
  }

  async countByScriptId(scriptId: string): Promise<number> {
    return this.sceneRepository.countByScriptId(scriptId);
  }

  /**
   * Get unique scenes by task ID with pagination
   * Returns scenes from the script associated with the task
   */
  async getScenesByTaskIdPaginated(
    taskId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    // Verify script exists with this taskId
    const script = await this.scriptRepository.findByTaskId(taskId);
    if (!script) {
      throw new NotFoundException(`Script with taskId ${taskId} not found`);
    }

    const { data, total, page, limit } =
      await this.sceneRepository.findByTaskIdWithPagination(taskId, options);

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      message: 'Scenes retrieved successfully',
      data: { items: data, total, page, limit, totalPages, hasNext, hasPrev },
    };
  }

  /**
   * Get unique scenes by project ID with pagination
   * Returns unique scenes from all scripts in the project
   */
  async getScenesByProjectIdPaginated(
    projectId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ): Promise<any> {
    // Verify project has scripts
    const scripts = await this.scriptRepository.findByProjectId(projectId);
    if (scripts.length === 0) {
      throw new NotFoundException(`No scripts found for project ${projectId}`);
    }

    const { data, total, page, limit } =
      await this.sceneRepository.findByProjectIdWithPagination(
        projectId,
        options,
      );

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      success: true,
      message: 'Scenes retrieved successfully',
      data: { items: data, total, page, limit, totalPages, hasNext, hasPrev },
    };
  }
}
