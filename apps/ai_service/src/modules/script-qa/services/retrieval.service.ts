import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface ChunkResult {
  id: string;
  scriptId: string;
  sceneId: string | null;
  sceneNumber: number | null;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  characters: string[] | null;
  location: string | null;
  timeOfDay: string | null;
  text: string;
  tokenCount: number;
  similarity: number;
}

export interface ScriptMeta {
  scriptId: string;
  summary: string | null;
  characters: any;
  scenes: any;
  themes: any;
  genres: string[] | null;
  tone: string | null;
  style: string | null;
  structure: string | null;
  pacing: string | null;
  targetAudience: string | null;
  dialogue: string | null;
}

export interface ScriptMetaShort {
  title: string;
  logline: string | null;
  characterNames: string[];
}

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(private readonly dataSource: DataSource) {}

  async vectorSearch(
    scriptId: string,
    queryEmbedding: number[],
    topK = 10,
    filters?: { characters?: string[]; sceneNumbers?: number[] },
  ): Promise<ChunkResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    let query = `
      SELECT id, "scriptId", "sceneId", "sceneNumber", "chunkIndex",
             "pageStart", "pageEnd", characters, location, "timeOfDay",
             text, "tokenCount",
             1 - (embedding <=> $1::vector) AS similarity
      FROM ai_schema.script_chunks
      WHERE "scriptId" = $2
    `;
    const params: any[] = [embeddingStr, scriptId];
    let paramIdx = 3;

    if (filters?.characters?.length) {
      query += ` AND characters && $${paramIdx}::text[]`;
      params.push(filters.characters);
      paramIdx++;
    }

    if (filters?.sceneNumbers?.length) {
      query += ` AND "sceneNumber" = ANY($${paramIdx}::int[])`;
      params.push(filters.sceneNumbers);
      paramIdx++;
    }

    query += ` ORDER BY embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(topK);

    const rows = await this.dataSource.query(query, params);
    return rows as ChunkResult[];
  }

  async getScriptMeta(scriptId: string): Promise<ScriptMeta | null> {
    const rows = await this.dataSource.query(
      `SELECT "scriptId", summary, characters, scenes, themes, genres,
              tone, style, structure, pacing, "targetAudience", dialogue
       FROM ai_schema.script_analyses
       WHERE "scriptId" = $1 AND status = 'completed'
       ORDER BY "completedAt" DESC
       LIMIT 1`,
      [scriptId],
    );

    return rows[0] ?? null;
  }

  async getScriptMetaShort(scriptId: string): Promise<ScriptMetaShort> {
    const rows = await this.dataSource.query(
      `SELECT s.title, sa.summary AS logline
       FROM core_schema.scripts s
       LEFT JOIN ai_schema.script_analyses sa
         ON sa."scriptId" = s.id AND sa.status = 'completed'
       WHERE s.id = $1
       LIMIT 1`,
      [scriptId],
    );

    const row = rows[0];
    if (!row) return { title: 'Unknown', logline: null, characterNames: [] };

    const charRows = await this.dataSource.query(
      `SELECT DISTINCT unnest(characters) AS name
       FROM ai_schema.script_chunks
       WHERE "scriptId" = $1
       ORDER BY name`,
      [scriptId],
    );

    return {
      title: row.title,
      logline: row.logline,
      characterNames: charRows.map((r: any) => r.name),
    };
  }

  async hasEmbeddings(scriptId: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM ai_schema.script_chunks WHERE "scriptId" = $1 LIMIT 1`,
      [scriptId],
    );
    return rows.length > 0;
  }

  async getChunksByScene(
    scriptId: string,
    sceneNumbers: number[],
  ): Promise<ChunkResult[]> {
    const rows = await this.dataSource.query(
      `SELECT id, "scriptId", "sceneId", "sceneNumber", "chunkIndex",
              "pageStart", "pageEnd", characters, location, "timeOfDay",
              text, "tokenCount", 1.0 AS similarity
       FROM ai_schema.script_chunks
       WHERE "scriptId" = $1 AND "sceneNumber" = ANY($2::int[])
       ORDER BY "chunkIndex"`,
      [scriptId, sceneNumbers],
    );
    return rows as ChunkResult[];
  }
}
