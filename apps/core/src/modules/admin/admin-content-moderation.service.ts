import { Media, Recording, Script } from '@app/common';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AdminContentType } from './dto/delete-content.dto';

@Injectable()
export class AdminContentModerationService {
  constructor(private readonly dataSource: DataSource) {}

  async deleteContent(
    contentId: string,
    contentType: AdminContentType,
  ): Promise<{
    message: string;
    contentId: string;
    contentType: AdminContentType;
    deletedAt: string;
    cleanup: {
      detachedRelations: number;
      deletedOrphanMediaCount: number;
    };
  }> {
    const cleanup = await this.dataSource.transaction(async (manager) => {
      if (contentType === AdminContentType.SCRIPT) {
        return this.deleteScriptContent(manager, contentId);
      }
      if (contentType === AdminContentType.RECORDING) {
        return this.deleteRecordingContent(manager, contentId);
      }
      return this.deleteMediaContent(manager, contentId);
    });

    return {
      message: 'Content deleted successfully',
      contentId,
      contentType,
      deletedAt: new Date().toISOString(),
      cleanup,
    };
  }

  private async deleteScriptContent(
    manager: EntityManager,
    scriptId: string,
  ): Promise<{ detachedRelations: number; deletedOrphanMediaCount: number }> {
    const script = await manager.getRepository(Script).findOne({
      where: { id: scriptId },
      withDeleted: true,
    });
    if (!script) {
      throw new NotFoundException('Content not found');
    }

    const associatedMediaIds = await this.collectMediaIdsForScript(
      manager,
      scriptId,
    );

    const deleteResult = await manager
      .createQueryBuilder()
      .delete()
      .from(Script)
      .where('id = :scriptId', { scriptId })
      .execute();

    if (!deleteResult.affected) {
      throw new NotFoundException('Content not found');
    }

    const deletedOrphanMediaCount = await this.deleteOrphanMediaByIds(
      manager,
      associatedMediaIds,
    );

    return {
      detachedRelations: 0,
      deletedOrphanMediaCount,
    };
  }

  private async deleteRecordingContent(
    manager: EntityManager,
    recordingId: string,
  ): Promise<{ detachedRelations: number; deletedOrphanMediaCount: number }> {
    const recording = await manager.getRepository(Recording).findOne({
      where: { id: recordingId },
      withDeleted: true,
    });
    if (!recording) {
      throw new NotFoundException('Content not found');
    }

    const mediaIds = await this.collectMediaIdsForRecording(
      manager,
      recordingId,
    );

    const detachTakes = await manager.query(
      'DELETE FROM studio_schema.recording_takes WHERE "recordingId" = $1',
      [recordingId],
    );
    const detachResources = await manager.query(
      'DELETE FROM studio_schema.recording_media_resources WHERE "recordingId" = $1',
      [recordingId],
    );

    const deleteResult = await manager
      .createQueryBuilder()
      .delete()
      .from(Recording)
      .where('id = :recordingId', { recordingId })
      .execute();

    if (!deleteResult.affected) {
      throw new NotFoundException('Content not found');
    }

    const deletedOrphanMediaCount = await this.deleteOrphanMediaByIds(
      manager,
      mediaIds,
    );

    return {
      detachedRelations:
        (detachTakes?.rowCount ?? 0) + (detachResources?.rowCount ?? 0),
      deletedOrphanMediaCount,
    };
  }

  private async deleteMediaContent(
    manager: EntityManager,
    mediaId: string,
  ): Promise<{ detachedRelations: number; deletedOrphanMediaCount: number }> {
    const media = await manager.getRepository(Media).findOne({
      where: { id: mediaId },
      withDeleted: true,
    });
    if (!media) {
      throw new NotFoundException('Content not found');
    }

    const detachTakes = await manager.query(
      'DELETE FROM studio_schema.recording_takes WHERE "mediaId" = $1',
      [mediaId],
    );
    const detachResources = await manager.query(
      'DELETE FROM studio_schema.recording_media_resources WHERE "mediaId" = $1',
      [mediaId],
    );

    await manager
      .createQueryBuilder()
      .delete()
      .from(Media)
      .where('id = :mediaId', { mediaId })
      .execute();

    return {
      detachedRelations:
        (detachTakes?.rowCount ?? 0) + (detachResources?.rowCount ?? 0),
      deletedOrphanMediaCount: 0,
    };
  }

  private async collectMediaIdsForRecording(
    manager: EntityManager,
    recordingId: string,
  ): Promise<string[]> {
    const rows = await manager.query(
      `
      SELECT DISTINCT x."mediaId" AS id
      FROM (
        SELECT rt."mediaId"
        FROM studio_schema.recording_takes rt
        WHERE rt."recordingId" = $1
        UNION
        SELECT rmr."mediaId"
        FROM studio_schema.recording_media_resources rmr
        WHERE rmr."recordingId" = $1
      ) x
      `,
      [recordingId],
    );
    return rows.map((row: { id: string }) => row.id);
  }

  private async collectMediaIdsForScript(
    manager: EntityManager,
    scriptId: string,
  ): Promise<string[]> {
    const rows = await manager.query(
      `
      SELECT DISTINCT x."mediaId" AS id
      FROM (
        SELECT rt."mediaId"
        FROM studio_schema.recording_takes rt
        INNER JOIN studio_schema.recordings r ON r.id = rt."recordingId"
        WHERE r."scriptId" = $1
        UNION
        SELECT rmr."mediaId"
        FROM studio_schema.recording_media_resources rmr
        INNER JOIN studio_schema.recordings r ON r.id = rmr."recordingId"
        WHERE r."scriptId" = $1
      ) x
      `,
      [scriptId],
    );
    return rows.map((row: { id: string }) => row.id);
  }

  private async deleteOrphanMediaByIds(
    manager: EntityManager,
    mediaIds: string[],
  ): Promise<number> {
    if (!mediaIds.length) {
      return 0;
    }

    const orphanRows = await manager.query(
      `
      SELECT m.id
      FROM media_schema.media m
      LEFT JOIN studio_schema.recording_takes rt
        ON rt."mediaId" = m.id
      LEFT JOIN studio_schema.recording_media_resources rmr
        ON rmr."mediaId" = m.id
      WHERE m.id = ANY($1::uuid[])
      GROUP BY m.id
      HAVING COUNT(rt."recordingId") = 0
         AND COUNT(rmr."recordingId") = 0
      `,
      [mediaIds],
    );

    const orphanIds = orphanRows.map((row: { id: string }) => row.id);
    if (!orphanIds.length) {
      return 0;
    }

    await manager.query(
      'DELETE FROM media_schema.media WHERE id = ANY($1::uuid[])',
      [orphanIds],
    );

    return orphanIds.length;
  }
}
