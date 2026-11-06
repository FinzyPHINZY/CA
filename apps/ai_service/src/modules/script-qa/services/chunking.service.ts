import { Injectable, Logger } from '@nestjs/common';
import { SceneRepository } from '@app/common';
import { Scene } from '@app/common';

export interface ChunkData {
  sceneId: string | null;
  sceneNumber: number | null;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  characters: string[];
  location: string | null;
  timeOfDay: string | null;
  text: string;
  tokenCount: number;
}

interface SceneElement {
  type?: 'dialogue' | 'action' | 'parenthetical';
  characterName: string | null;
  lines: string[];
}

const DEFAULT_CHUNK_TARGET = 800;
const DEFAULT_CHUNK_OVERLAP = 80;
const SPLIT_TARGET = 600;

@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);

  constructor(private readonly sceneRepository: SceneRepository) {}

  async chunkScript(scriptId: string): Promise<ChunkData[]> {
    const scenes = await this.sceneRepository.findByScriptId(scriptId);
    if (!scenes.length) {
      this.logger.warn(`No scenes found for script ${scriptId}`);
      return [];
    }

    const chunks: ChunkData[] = [];

    for (const scene of scenes) {
      const text = this.renderSceneText(scene);
      if (!text.trim()) continue;

      const tokenCount = this.estimateTokens(text);
      const { location, timeOfDay } = this.parseHeading(scene.heading);
      const characters = this.extractCharacters(scene.dialogues);
      const pageStart = scene.pages?.[0] ?? null;
      const pageEnd = scene.pages?.[scene.pages.length - 1] ?? null;

      if (tokenCount <= DEFAULT_CHUNK_TARGET) {
        chunks.push({
          sceneId: scene.id,
          sceneNumber: scene.number,
          chunkIndex: chunks.length,
          pageStart,
          pageEnd,
          characters,
          location,
          timeOfDay,
          text,
          tokenCount,
        });
      } else {
        const subChunks = this.splitSceneByBeat(
          scene,
          text,
          characters,
          location,
          timeOfDay,
          pageStart,
          pageEnd,
        );
        for (const sc of subChunks) {
          sc.chunkIndex = chunks.length;
          chunks.push(sc);
        }
      }
    }

    this.logger.log(
      `Chunked script ${scriptId}: ${scenes.length} scenes → ${chunks.length} chunks`,
    );
    return chunks;
  }

  private renderSceneText(scene: Scene): string {
    const parts: string[] = [];

    if (scene.heading) {
      parts.push(scene.heading);
    }

    for (const element of scene.dialogues ?? []) {
      const type = (element.type ?? 'dialogue') as string;
      const lines = (element.lines ?? []).join(' ');

      switch (type) {
        case 'dialogue':
          if (element.characterName) {
            parts.push(`${element.characterName}: ${lines}`);
          } else {
            parts.push(lines);
          }
          break;
        case 'parenthetical':
          if (element.characterName) {
            parts.push(`${element.characterName} ${lines}`);
          } else {
            parts.push(lines);
          }
          break;
        case 'action':
        default:
          parts.push(lines);
          break;
      }
    }

    return parts.join('\n');
  }

  private splitSceneByBeat(
    scene: Scene,
    _fullText: string,
    characters: string[],
    location: string | null,
    timeOfDay: string | null,
    pageStart: number | null,
    pageEnd: number | null,
  ): ChunkData[] {
    const elements = scene.dialogues ?? [];
    const subChunks: ChunkData[] = [];
    let currentParts: string[] = [];
    let currentTokens = 0;

    if (scene.heading) {
      currentParts.push(scene.heading);
      currentTokens += this.estimateTokens(scene.heading);
    }

    for (let i = 0; i < elements.length; i++) {
      const rendered = this.renderElement(elements[i]);
      const elementTokens = this.estimateTokens(rendered);

      if (
        currentTokens + elementTokens > SPLIT_TARGET &&
        currentParts.length > 0
      ) {
        subChunks.push({
          sceneId: scene.id,
          sceneNumber: scene.number,
          chunkIndex: 0,
          pageStart,
          pageEnd,
          characters,
          location,
          timeOfDay,
          text: currentParts.join('\n'),
          tokenCount: currentTokens,
        });

        // Overlap: carry last few elements (~80 tokens worth)
        const overlapParts: string[] = [];
        let overlapTokens = 0;
        for (let j = currentParts.length - 1; j >= 0 && overlapTokens < DEFAULT_CHUNK_OVERLAP; j--) {
          overlapParts.unshift(currentParts[j]);
          overlapTokens += this.estimateTokens(currentParts[j]);
        }
        currentParts = overlapParts;
        currentTokens = overlapTokens;
      }

      currentParts.push(rendered);
      currentTokens += elementTokens;
    }

    if (currentParts.length > 0) {
      subChunks.push({
        sceneId: scene.id,
        sceneNumber: scene.number,
        chunkIndex: 0,
        pageStart,
        pageEnd,
        characters,
        location,
        timeOfDay,
        text: currentParts.join('\n'),
        tokenCount: currentTokens,
      });
    }

    return subChunks;
  }

  private renderElement(element: SceneElement): string {
    const type = (element.type ?? 'dialogue') as string;
    const lines = (element.lines ?? []).join(' ');

    if (type === 'dialogue' && element.characterName) {
      return `${element.characterName}: ${lines}`;
    }
    if (type === 'parenthetical' && element.characterName) {
      return `${element.characterName} ${lines}`;
    }
    return lines;
  }

  private parseHeading(
    heading: string | null,
  ): { location: string | null; timeOfDay: string | null } {
    if (!heading) return { location: null, timeOfDay: null };

    // INT. KITCHEN - DAY  or  EXT. ROOFTOP - NIGHT
    const match = heading.match(
      /^(?:INT|EXT|INT\/EXT|I\/E)[.\s]+(.+?)(?:\s*[-–—]\s*(DAY|NIGHT|DAWN|DUSK|MORNING|EVENING|AFTERNOON|CONTINUOUS|LATER|MOMENTS LATER))?$/i,
    );

    if (!match) return { location: heading.trim(), timeOfDay: null };

    return {
      location: match[1]?.trim() || null,
      timeOfDay: match[2]?.toUpperCase() || null,
    };
  }

  private extractCharacters(
    dialogues: Scene['dialogues'],
  ): string[] {
    if (!dialogues) return [];
    const names = new Set<string>();
    for (const el of dialogues) {
      if (el.characterName) {
        names.add(el.characterName.toUpperCase());
      }
    }
    return Array.from(names).sort();
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
  }
}
