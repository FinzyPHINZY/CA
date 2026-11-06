import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ScriptMaterial } from '../entities/script-material.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class ScriptMaterialRepository extends BaseRepository<ScriptMaterial> {
  constructor(dataSource: DataSource) {
    super(ScriptMaterial, dataSource.manager);
  }

  async findByScriptId(
    scriptId: string,
    type?: string,
  ): Promise<ScriptMaterial[]> {
    const qb = this.createQueryBuilder('material')
      .where('material.scriptId = :scriptId', { scriptId })
      .andWhere('material.deletedAt IS NULL')
      .orderBy('material.createdAt', 'ASC');

    if (type) {
      qb.andWhere('material.type = :type', { type });
    }

    return qb.getMany();
  }

  async findByProjectId(
    projectId: string,
    type?: string,
    scriptId?: string,
  ): Promise<ScriptMaterial[]> {
    const qb = this.createQueryBuilder('material')
      .where('material.projectId = :projectId', { projectId })
      .andWhere('material.deletedAt IS NULL')
      .orderBy('material.createdAt', 'ASC');

    if (type) {
      qb.andWhere('material.type = :type', { type });
    }

    if (scriptId) {
      qb.andWhere('material.scriptId = :scriptId', { scriptId });
    }

    return qb.getMany();
  }

  async findByIdAndUserId(
    id: string,
    userId: string,
  ): Promise<ScriptMaterial | null> {
    return this.findOne({ where: { id, userId }, withDeleted: false });
  }
}
