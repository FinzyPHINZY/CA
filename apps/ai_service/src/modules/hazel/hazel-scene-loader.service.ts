// loads scene dialogue elements from the DB and validates actor character membership.

import { SceneRepository } from '@app/common';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

export interface SceneDialogueElement {
  type?: 'dialogue' | 'action' | 'parenthetical';
  characterId?: string | null;
  characterName: string | null;
  lines: string[];
}

@Injectable()
export class HazelSceneLoaderService {
  private readonly logger = new Logger(HazelSceneLoaderService.name);

  constructor(private readonly sceneRepository: SceneRepository) {}

  // load the full dialogue element array for a scene.
  // validates that actorCharacterId is a participant in the scene.
  async loadScene(
    sceneId: string,
    actorCharacterId: string,
  ): Promise<SceneDialogueElement[]> {
    const scene = await this.sceneRepository.findByIdWithCharacters(sceneId);
    if (!scene) {
      throw new NotFoundException(`Scene not found: ${sceneId}`);
    }

    // build canonical lookups from the scene character set
    const canonicalCharacterIds = new Set<string>();
    const charNameToId = new Map<string, string>();
    for (const c of scene.characters ?? []) {
      if (c.id) {
        canonicalCharacterIds.add(c.id);
      }
      if (c.id && c.name) {
        charNameToId.set(c.name.trim().toUpperCase(), c.id);
      }
    }

    // validate actor character is in this scene
    if (!canonicalCharacterIds.has(actorCharacterId)) {
      throw new BadRequestException(
        `Character ${actorCharacterId} is not in scene ${sceneId}`,
      );
    }

    const elements: SceneDialogueElement[] = (scene.dialogues ?? []).map(
      (d) => {
        let characterId = d.characterId ?? null;
        const normalizedName = d.characterName?.trim().toUpperCase() ?? null;
        const canonicalIdFromName = normalizedName
          ? (charNameToId.get(normalizedName) ?? null)
          : null;

        // Normalize denormalized dialogue metadata to canonical scene character IDs.
        // Some scenes retain stale line-level characterIds after analysis refreshes.
        if (characterId && !canonicalCharacterIds.has(characterId)) {
          if (canonicalIdFromName) {
            this.logger.warn(
              `Replacing stale characterId ${characterId} with canonical ${canonicalIdFromName} for "${d.characterName}" in scene ${sceneId}`,
            );
            characterId = canonicalIdFromName;
          } else {
            this.logger.warn(
              `Stale characterId ${characterId} has no canonical name match in scene ${sceneId}`,
            );
          }
        }

        // Backfill missing characterId by matching characterName against scene.characters.
        if (!characterId && d.characterName) {
          if (canonicalIdFromName) {
            characterId = canonicalIdFromName;
          } else {
            this.logger.warn(
              `No character match for "${d.characterName}" in scene ${sceneId}`,
            );
          }
        }

        return {
          type: d.type ?? 'dialogue',
          characterId,
          characterName: d.characterName ?? null,
          lines: d.lines ?? [],
        };
      },
    );

    this.logger.log(
      `Loaded scene ${sceneId}: ${elements.length} elements, actor=${actorCharacterId}`,
    );

    return elements;
  }
}
