/** biome-ignore-all lint/suspicious/noAssignInExpressions: <> */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

// parsed element from an FDX file — a single dialogue, action, or parenthetical.
export interface FdxSceneElement {
  type: 'dialogue' | 'action' | 'parenthetical';
  characterName: string | null;
  lines: string[];
  page?: number | null;
}

export interface FdxScene {
  number: number;
  heading: string;
  elements: FdxSceneElement[];
  characters: string[];
  page?: number | null;
  pages?: number[];
}

export interface FdxParseResult {
  title: string | null;
  scenes: FdxScene[];
  characters: string[];
  rawText: string;
}

// deterministic parser for Final Draft XML (.fdx) files.
// extracts scene structure, characters, dialogue, action lines, and parentheticals from FDX XML without any LLM involvement.
@Injectable()
export class FdxParserService {
  private readonly logger = new Logger(FdxParserService.name);

  // parse an FDX file buffer into structured script data.
  async parse(buffer: Buffer): Promise<FdxParseResult> {
    const xml = buffer.toString('utf-8');

    // basic XML validation
    if (!xml.includes('<FinalDraft') && !xml.includes('<Content')) {
      throw new BadRequestException(
        'Invalid FDX file: does not appear to be a Final Draft XML document.',
      );
    }

    const title = this.extractTitle(xml);
    const paragraphs = this.extractParagraphs(xml);
    const { scenes, characters, rawText } =
      this.buildScenesFromParagraphs(paragraphs);

    this.logger.log(
      `FDX parsed: title="${title}", ${scenes.length} scenes, ${characters.length} characters`,
    );

    return { title, scenes, characters, rawText };
  }

  // extract title from TitlePage or HeaderAndFooter elements.
  private extractTitle(xml: string): string | null {
    // try TitlePage Content
    const titleMatch = xml.match(
      /<TitlePage>[\s\S]*?<Content>[\s\S]*?<Paragraph[^>]*>\s*<Text[^>]*>([\s\S]*?)<\/Text>/,
    );
    if (titleMatch?.[1]) {
      return this.stripTags(titleMatch[1]).trim() || null;
    }
    return null;
  }

  // extract all Paragraph elements with their Type and text content.
  private extractParagraphs(
    xml: string,
  ): Array<{ type: string; text: string; speaker?: string }> {
    const paragraphs: Array<{
      type: string;
      text: string;
      speaker?: string;
    }> = [];

    // match all Paragraph elements inside Content (skip TitlePage)
    const contentMatch = xml.match(/<Content>([\s\S]*)<\/Content>/);
    if (!contentMatch) return paragraphs;

    const content = contentMatch[1];

    // match paragraphs — FDX uses Type attribute to identify element type
    const paraRegex =
      /<Paragraph\s+[^>]*?Type="([^"]*)"[^>]*?>([\s\S]*?)<\/Paragraph>/g;
    let match: RegExpExecArray | null;

    while ((match = paraRegex.exec(content)) !== null) {
      const type = match[1];
      const innerXml = match[2];

      // extract text from Text elements within the paragraph
      const textParts: string[] = [];
      const textRegex = /<Text[^>]*>([\s\S]*?)<\/Text>/g;
      let textMatch: RegExpExecArray | null;
      while ((textMatch = textRegex.exec(innerXml)) !== null) {
        textParts.push(this.stripTags(textMatch[1]));
      }

      const text = textParts.join('').trim();
      if (!text) continue;

      paragraphs.push({ type, text });
    }

    return paragraphs;
  }

  // walk through paragraphs and group them into scenes.
  // FDX paragraph types:
  // - "Scene Heading" → starts a new scene
  // - "Character" → character name (speaker for following dialogue)
  // - "Dialogue" → spoken lines
  // - "Parenthetical" → actor direction
  // - "Action" → stage directions
  // - "Transition" → treated as action
  // - "General" → treated as action
  private buildScenesFromParagraphs(
    paragraphs: Array<{ type: string; text: string }>,
  ): { scenes: FdxScene[]; characters: string[]; rawText: string } {
    const scenes: FdxScene[] = [];
    const allCharacters = new Set<string>();
    const rawTextParts: string[] = [];

    let currentScene: FdxScene | null = null;
    let currentSpeaker: string | null = null;
    let sceneNumber = 0;

    for (const para of paragraphs) {
      rawTextParts.push(para.text);

      switch (para.type) {
        case 'Scene Heading': {
          // start a new scene
          sceneNumber++;
          currentScene = {
            number: sceneNumber,
            heading: para.text,
            elements: [],
            characters: [],
          };
          scenes.push(currentScene);
          currentSpeaker = null;
          break;
        }

        case 'Character': {
          const name = para.text
            .replace(/\s*\(.*\)\s*$/, '')
            .trim()
            .toUpperCase();
          currentSpeaker = name;
          allCharacters.add(name);
          if (currentScene && !currentScene.characters.includes(name)) {
            currentScene.characters.push(name);
          }
          break;
        }

        case 'Dialogue': {
          if (!currentScene) break;
          currentScene.elements.push({
            type: 'dialogue',
            characterName: currentSpeaker,
            lines: [para.text],
          });
          break;
        }

        case 'Parenthetical': {
          if (!currentScene) break;
          currentScene.elements.push({
            type: 'parenthetical',
            characterName: currentSpeaker,
            lines: [para.text],
          });
          break;
        }

        case 'Action':
        case 'Transition':
        case 'General':
        default: {
          if (!currentScene) {
            // content before first scene heading — create an implicit scene
            if (
              para.type === 'Action' ||
              para.type === 'Transition' ||
              para.type === 'General'
            ) {
              sceneNumber++;
              currentScene = {
                number: sceneNumber,
                heading: 'OPENING',
                elements: [],
                characters: [],
              };
              scenes.push(currentScene);
            } else {
              break;
            }
          }
          currentScene.elements.push({
            type: 'action',
            characterName: null,
            lines: [para.text],
          });
          currentSpeaker = null;
          break;
        }
      }
    }

    return {
      scenes,
      characters: Array.from(allCharacters),
      rawText: rawTextParts.join('\n'),
    };
  }

  // strip HTML/XML tags from a string.
  private stripTags(str: string): string {
    return str.replace(/<[^>]+>/g, '');
  }
}
