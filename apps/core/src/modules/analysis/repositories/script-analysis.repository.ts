import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ScriptAnalysis } from '../entities/script-analysis.entity';
import { BaseRepository } from '@app/common';

@Injectable()
export class ScriptAnalysisRepository extends BaseRepository<ScriptAnalysis> {
  constructor(dataSource: DataSource) {
    super(ScriptAnalysis, dataSource.manager);
  }

  /**
   * Find analysis by ID
   */
  async findById(id: string): Promise<ScriptAnalysis | null> {
    return super.findById(id);
  }

  /**
   * Find analysis by ID or throw error
   */
  async findByIdOrFail(id: string): Promise<ScriptAnalysis> {
    return super.findByIdOrFail(id);
  }

  /**
   * Find analysis by script ID
   */
  async findByScriptId(scriptId: string): Promise<ScriptAnalysis | null> {
    return this.findOneBy({ scriptId } as any);
  }

  /**
   * Find analysis by task ID
   */
  async findByTaskId(taskId: string): Promise<ScriptAnalysis | null> {
    return this.findOneBy({ taskId } as any);
  }

  /**
   * Find analysis by task ID and user ID
   * Includes script and script.defaultCharacter relations
   */
  async findByTaskIdAndUserId(
    taskId: string,
    userId: string,
  ): Promise<ScriptAnalysis | null> {
    return this.createQueryBuilder('analysis')
      .where('analysis.taskId = :taskId', { taskId })
      .andWhere('analysis.userId = :userId', { userId })
      .leftJoinAndSelect('analysis.script', 'script')
      .leftJoinAndSelect('script.defaultCharacter', 'defaultCharacter')
      .getOne();
  }

  /**
   * Create analysis
   */
  async createAnalysis(
    analysisData: Partial<ScriptAnalysis>,
  ): Promise<ScriptAnalysis> {
    return this.createEntity(analysisData);
  }

  /**
   * Update analysis
   */
  async updateAnalysis(
    id: string,
    analysisData: Partial<ScriptAnalysis>,
  ): Promise<ScriptAnalysis | null> {
    return this.updateByIdAndReturn(id, analysisData);
  }

  /**
   * Delete analysis by ID
   */
  async deleteAnalysis(id: string): Promise<void> {
    await this.hardDelete(id);
  }
}
