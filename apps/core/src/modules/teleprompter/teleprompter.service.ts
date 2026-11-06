/** biome-ignore-all lint/style/useImportType: <> */

import {
  SceneRepository,
  ScriptRepository,
  UserTeleprompterPreference,
  UserTeleprompterPreferenceRepository,
} from '@app/common';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TeleprompterElementDto } from './dto/teleprompter-element.dto';
import { UpdateTeleprompterPreferencesDto } from './dto/update-teleprompter-preferences.dto';
import { buildScriptAnalysisLifecycleSummary } from '../script/script-analysis-lifecycle.util';

const DEFAULT_PREFERENCES: Omit<
  UserTeleprompterPreference,
  'id' | 'userId' | 'createdAt' | 'updatedAt' | 'deletedAt'
> = {
  defaultScrollSpeed: 150,
  fontSize: 32,
  blackoutMode: false,
  showActionLines: true,
  showParentheticals: true,
  highlightColor: '#FFD700',
};

@Injectable()
export class TeleprompterService {
  constructor(
    private readonly preferenceRepository: UserTeleprompterPreferenceRepository,
    private readonly sceneRepository: SceneRepository,
    private readonly scriptRepository: ScriptRepository,
  ) {}

  // get user's teleprompter preferences or return defaults.
  async getPreferences(userId: string): Promise<any> {
    const existing = await this.preferenceRepository.findByUserId(userId);
    const data = existing
      ? {
          userId: existing.userId,
          defaultScrollSpeed: existing.defaultScrollSpeed,
          fontSize: existing.fontSize,
          blackoutMode: existing.blackoutMode,
          showActionLines: existing.showActionLines,
          showParentheticals: existing.showParentheticals,
          highlightColor: existing.highlightColor,
        }
      : { userId, ...DEFAULT_PREFERENCES };
    return {
      success: true,
      message: 'Preferences retrieved successfully',
      data,
    };
  }

  // update user's teleprompter preferences (upsert).
  async updatePreferences(
    userId: string,
    dto: UpdateTeleprompterPreferencesDto,
  ): Promise<any> {
    const data = await this.preferenceRepository.upsertByUserId(userId, dto);
    return { success: true, message: 'Preferences updated successfully', data };
  }

  // format a single scene for teleprompter display. the characterId identifies the actor's character — their lines get isActor: true.
  async getSceneTeleprompter(
    sceneId: string,
    characterId: string,
    userId: string,
  ): Promise<any> {
    const scene = await this.sceneRepository.findByIdWithCharacters(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene with ID ${sceneId} not found`);
    }

    const script = await this.scriptRepository.findById(scene.scriptId);
    this.assertScriptAccess(script, scene.scriptId, userId);
    const metadata = this.buildScriptMetadata(script);
    const elements = this.formatDialoguesForTeleprompter(
      scene.dialogues || [],
      characterId,
    );

    return {
      success: true,
      message: 'Scene retrieved successfully',
      data: {
        sceneId: scene.id,
        sceneNumber: scene.number,
        heading: scene.heading,
        pages: scene.pages || null,
        elements,
      },
      metadata,
    };
  }

  // format all scenes in a script for teleprompter display. returns scenes ordered by scene number with teleprompter-formatted content.
  async getScriptTeleprompterScenes(
    scriptId: string,
    characterId: string,
    userId: string,
  ): Promise<any> {
    const script = await this.scriptRepository.findById(scriptId);
    this.assertScriptAccess(script, scriptId, userId);

    const scenes =
      await this.sceneRepository.findByScriptIdWithCharacters(scriptId);

    // Sort by scene number
    scenes.sort((a, b) => a.number - b.number);

    const metadata = this.buildScriptMetadata(script);
    const data = scenes.map((scene) => ({
      sceneId: scene.id,
      sceneNumber: scene.number,
      heading: scene.heading,
      pages: scene.pages || null,
      elements: this.formatDialoguesForTeleprompter(
        scene.dialogues || [],
        characterId,
      ),
    }));

    return {
      success: true,
      message: 'Script scenes retrieved successfully',
      data,
      metadata,
    };
  }

  // transform raw dialogue entries into teleprompter elements.
  private formatDialoguesForTeleprompter(
    dialogues: Array<{
      type?: 'dialogue' | 'action' | 'parenthetical';
      characterId?: string | null;
      characterName: string | null;
      lines: string[];
      page?: number | null;
    }>,
    actorCharacterId: string,
  ): TeleprompterElementDto[] {
    return dialogues.map((entry) => {
      const type = entry.type || 'dialogue';
      const isActor =
        type === 'dialogue' && entry.characterId === actorCharacterId;

      return {
        type,
        characterName: entry.characterName,
        characterId: entry.characterId || null,
        lines: entry.lines,
        isActor,
        page: entry.page ?? null,
      };
    });
  }

  private buildScriptMetadata(script: any | null) {
    const parserMetadata = (script as any)?.parserMetadata || {};
    return {
      analysisLifecycle: buildScriptAnalysisLifecycleSummary(script),
      structuralWarnings: parserMetadata.structuralWarnings || [],
      extractionSource: parserMetadata.extractionSource || null,
      coverageRatio:
        parserMetadata.coverageRatio ?? parserMetadata.pagesParsedRatio ?? null,
      parsedPages: parserMetadata.parsedPages || [],
      dualColumnDetected:
        parserMetadata.structuralFlags?.dualColumnDetected ?? null,
      removedHeaderFooterLines:
        parserMetadata.structuralFlags?.removedHeadersOrFooters ?? null,
      removedWatermarks:
        parserMetadata.structuralFlags?.removedWatermarks ?? null,
    };
  }

  private assertScriptAccess(
    script: { userId: string } | null,
    scriptId: string,
    userId: string,
  ): void {
    if (!script) {
      throw new NotFoundException(`Script with ID ${scriptId} not found`);
    }

    if (script.userId !== userId) {
      throw new ForbiddenException(
        'You are not authorized to access this teleprompter content',
      );
    }
  }
}
