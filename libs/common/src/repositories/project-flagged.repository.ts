import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectFlagged } from '../entities/project-flagged.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class ProjectFlaggedRepository extends BaseRepository<ProjectFlagged> {
  constructor(dataSource: DataSource) {
    super(ProjectFlagged, dataSource.manager);
  }

  async findLatestFlagByProjectId(
    projectId: string,
  ): Promise<ProjectFlagged | null> {
    return this.findOne({
      where: { projectId } as any,
      order: { createdAt: 'DESC' },
    });
  }
}
