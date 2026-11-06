import { Injectable } from '@nestjs/common';
import { Character, CharacterRepository } from '@app/common';
// import { AnalysisService } from '../analysis/analysis.service';

@Injectable()
export class CharacterService {
  constructor(
    private readonly characterRepository: CharacterRepository,
    // private readonly analysisService: AnalysisService,
  ) {}

  async getCharactersByScriptId(scriptId: string): Promise<any[]> {
    // Prefer normalized characters; fallback to analysis JSON if present
    const characters = await this.characterRepository.findByScriptId(scriptId);
    if (characters.length > 0) {
      return characters;
    }
    // const analysis = await this.analysisService.findByScriptId(scriptId);
    // return (analysis as any)?.characters || [];
    return [];
  }

  async getCharactersByScriptIdPaginated(
    scriptId: string,
    options: {
      page?: number;
      limit?: number;
      search?: string;
      sortBy?: string;
      sortOrder?: 'ASC' | 'DESC';
    } = {},
  ) {
    const { data, total, page, limit } =
      await this.characterRepository.findByScriptIdWithPagination(
        scriptId,
        options,
      );

    const totalPages = Math.ceil(total / limit);
    const hasNext = page < totalPages;
    const hasPrev = page > 1;

    return {
      data,
      total,
      page,
      limit,
      totalPages,
      hasNext,
      hasPrev,
    };
  }

  async findById(id: string): Promise<Character | null> {
    return this.characterRepository.findById(id);
  }

  async findByScriptId(scriptId: string): Promise<Character[]> {
    return this.characterRepository.findByScriptId(scriptId);
  }

  async findByScriptIdWithScenes(scriptId: string): Promise<Character[]> {
    return this.characterRepository.findByScriptIdWithScenes(scriptId);
  }

  async findByScriptIdAndName(
    scriptId: string,
    name: string,
  ): Promise<Character | null> {
    return this.characterRepository.findByScriptIdAndName(scriptId, name);
  }

  async findByName(name: string): Promise<Character[]> {
    return this.characterRepository.findByName(name);
  }

  async create(characterData: Partial<Character>): Promise<Character> {
    return this.characterRepository.createCharacter(characterData);
  }

  async createMany(charactersData: Partial<Character>[]): Promise<Character[]> {
    return this.characterRepository.createCharacters(charactersData);
  }

  async update(
    id: string,
    characterData: Partial<Character>,
  ): Promise<Character | null> {
    return this.characterRepository.updateCharacter(id, characterData);
  }

  /**
   * Soft delete character
   * Soft deletes the character so it won't be returned in queries.
   */
  async delete(id: string): Promise<void> {
    await this.findById(id); // Verify character exists (will throw if not found or already soft-deleted)
    await this.characterRepository.deleteCharacter(id);
  }

  /**
   * Soft delete all characters for a script
   * Soft deletes all characters so they won't be returned in queries.
   */
  async deleteByScriptId(scriptId: string): Promise<void> {
    await this.characterRepository.deleteByScriptId(scriptId);
  }

  async countByScriptId(scriptId: string): Promise<number> {
    return this.characterRepository.countByScriptId(scriptId);
  }
}
