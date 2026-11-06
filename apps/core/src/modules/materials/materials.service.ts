/** biome-ignore-all lint/style/useImportType: <> */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MaterialType,
  Project,
  Script,
  ScriptMaterialRepository,
} from '@app/common';
import { DataSource } from 'typeorm';
import { CreateMaterialDto } from './dto/create-material.dto';

@Injectable()
export class MaterialsService {
  constructor(
    private readonly materialsRepository: ScriptMaterialRepository,
    private readonly dataSource: DataSource,
  ) {}

  async addMaterial(userId: string, scriptId: string, dto: CreateMaterialDto) {
    const script = await this.dataSource
      .getRepository(Script)
      .findOne({ where: { id: scriptId, userId } });

    if (!script) {
      throw new NotFoundException('Script not found');
    }

    if (!script.projectId) {
      throw new BadRequestException(
        'Script must belong to a project to add materials',
      );
    }

    this.validateTypeFields(dto);

    const material = await this.materialsRepository.createEntity({
      scriptId,
      projectId: script.projectId,
      userId,
      type: dto.type,
      title: dto.title,
      url: dto.url ?? null,
      textContent: dto.textContent ?? null,
      fileKey: dto.fileKey ?? null,
      fileUrl: dto.fileUrl ?? null,
      fileName: dto.fileName ?? null,
      fileSizeBytes: dto.fileSizeBytes ?? null,
      mimeType: dto.mimeType ?? null,
    });

    return {
      success: true,
      message: 'Material added successfully',
      data: material,
    };
  }

  async getMaterialsByScript(userId: string, scriptId: string, type?: string) {
    const script = await this.dataSource
      .getRepository(Script)
      .findOne({ where: { id: scriptId, userId } });

    if (!script) {
      throw new NotFoundException('Script not found');
    }

    const materials = await this.materialsRepository.findByScriptId(
      scriptId,
      type,
    );

    return {
      success: true,
      message: 'Materials retrieved successfully',
      data: materials,
    };
  }

  async getMaterialsByProject(
    userId: string,
    projectId: string,
    type?: string,
    scriptId?: string,
  ) {
    const project = await this.dataSource
      .getRepository(Project)
      .findOne({ where: { id: projectId, userId } });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const materials = await this.materialsRepository.findByProjectId(
      projectId,
      type,
      scriptId,
    );

    return {
      success: true,
      message: 'Materials retrieved successfully',
      data: materials,
    };
  }

  async deleteMaterial(userId: string, materialId: string) {
    const material = await this.materialsRepository.findByIdAndUserId(
      materialId,
      userId,
    );

    if (!material) {
      throw new NotFoundException('Material not found');
    }

    await this.materialsRepository.softRemoveById(materialId);

    return { success: true, message: 'Material deleted successfully' };
  }

  private validateTypeFields(dto: CreateMaterialDto): void {
    if (dto.type === MaterialType.LINK) {
      if (!dto.url) {
        throw new BadRequestException('url is required for link materials');
      }
    } else if (dto.type === MaterialType.TEXT) {
      if (!dto.textContent) {
        throw new BadRequestException(
          'textContent is required for text materials',
        );
      }
    } else if (dto.type === MaterialType.FILE) {
      if (!dto.fileKey || !dto.fileUrl || !dto.fileName) {
        throw new BadRequestException(
          'fileKey, fileUrl, and fileName are required for file materials',
        );
      }
    }
  }
}
