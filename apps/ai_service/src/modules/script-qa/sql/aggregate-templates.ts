export interface AggregateTemplate {
  name: string;
  matchPatterns: RegExp[];
  sql: string;
  paramExtractor: (filters: {
    characters?: string[];
    sceneNumbers?: number[];
  }) => any[];
  formatFn: (rows: any[], params: any[]) => string;
}

export const AGGREGATE_TEMPLATES: AggregateTemplate[] = [
  {
    name: 'count_scenes_with_character',
    matchPatterns: [
      /how many scenes?\s+(?:is|are|does|do)\s+(\w+)\s+in/i,
      /how many scenes?\s+(?:with|for|featuring)\s+(\w+)/i,
      /(\w+)\s+(?:appear|appears|is)\s+in\s+how many scenes/i,
    ],
    sql: `SELECT COUNT(DISTINCT "sceneNumber") AS count
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1 AND $2 = ANY(characters)`,
    paramExtractor: (f) => [f.characters?.[0]?.toUpperCase()],
    formatFn: (rows, params) =>
      `${params[0]} appears in ${rows[0]?.count ?? 0} scene(s).`,
  },
  {
    name: 'count_lines_by_character',
    matchPatterns: [
      /how many (?:lines?|dialogue)\s+(?:does|do)\s+(\w+)\s+have/i,
      /(\w+)(?:'s)?\s+(?:line|dialogue)\s+count/i,
    ],
    sql: `SELECT COUNT(*) AS count
          FROM ai_schema.script_chunks,
               LATERAL unnest(string_to_array(text, E'\\n')) AS line
          WHERE "scriptId" = $1 AND line ~* ('^' || $2 || ':')`,
    paramExtractor: (f) => [f.characters?.[0]?.toUpperCase()],
    formatFn: (rows, params) =>
      `${params[0]} has approximately ${rows[0]?.count ?? 0} dialogue line(s).`,
  },
  {
    name: 'count_words_by_character',
    matchPatterns: [
      /how many words?\s+(?:does|do)\s+(\w+)\s+(?:speak|say|have)/i,
    ],
    sql: `SELECT SUM(array_length(string_to_array(trim(substring(line from length($2) + 2)), ' '), 1)) AS count
          FROM ai_schema.script_chunks,
               LATERAL unnest(string_to_array(text, E'\\n')) AS line
          WHERE "scriptId" = $1 AND line ~* ('^' || $2 || ':')`,
    paramExtractor: (f) => [f.characters?.[0]?.toUpperCase()],
    formatFn: (rows, params) =>
      `${params[0]} speaks approximately ${rows[0]?.count ?? 0} word(s).`,
  },
  {
    name: 'list_scenes_with_character',
    matchPatterns: [
      /which scenes?\s+(?:is|are|does|do)\s+(\w+)\s+in/i,
      /(?:list|show)\s+(?:all\s+)?scenes?\s+(?:with|for|featuring)\s+(\w+)/i,
    ],
    sql: `SELECT DISTINCT "sceneNumber", "pageStart", location
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1 AND $2 = ANY(characters)
          ORDER BY "sceneNumber"`,
    paramExtractor: (f) => [f.characters?.[0]?.toUpperCase()],
    formatFn: (rows, params) => {
      if (!rows.length) return `${params[0]} was not found in any scenes.`;
      const list = rows
        .map((r) => {
          let s = `Scene ${r.sceneNumber}`;
          if (r.pageStart) s += ` (p. ${r.pageStart})`;
          if (r.location) s += ` — ${r.location}`;
          return s;
        })
        .join('\n- ');
      return `${params[0]} appears in ${rows.length} scene(s):\n- ${list}`;
    },
  },
  {
    name: 'list_characters_in_scene',
    matchPatterns: [
      /who(?:'s| is| are)\s+in scene\s+(\d+)/i,
      /(?:list|show)\s+characters?\s+in scene\s+(\d+)/i,
    ],
    sql: `SELECT DISTINCT unnest(characters) AS name
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1 AND "sceneNumber" = $2
          ORDER BY name`,
    paramExtractor: (f) => [f.sceneNumbers?.[0]],
    formatFn: (rows, params) => {
      if (!rows.length) return `No characters found in scene ${params[0]}.`;
      return `Characters in scene ${params[0]}: ${rows.map((r) => r.name).join(', ')}.`;
    },
  },
  {
    name: 'list_characters',
    matchPatterns: [
      /(?:list|show|who are)\s+(?:all\s+)?(?:the\s+)?characters/i,
      /how many characters/i,
    ],
    sql: `SELECT DISTINCT unnest(characters) AS name
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1
          ORDER BY name`,
    paramExtractor: () => [],
    formatFn: (rows) => {
      if (!rows.length) return 'No characters found.';
      return `${rows.length} character(s): ${rows.map((r) => r.name).join(', ')}.`;
    },
  },
  {
    name: 'total_scenes',
    matchPatterns: [
      /how many scenes/i,
      /total (?:number of )?scenes/i,
    ],
    sql: `SELECT COUNT(DISTINCT "sceneNumber") AS count
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1`,
    paramExtractor: () => [],
    formatFn: (rows) =>
      `The script has ${rows[0]?.count ?? 0} scene(s).`,
  },
  {
    name: 'total_pages',
    matchPatterns: [
      /how many pages/i,
      /total (?:number of )?pages/i,
      /how long is (?:the|this) script/i,
    ],
    sql: `SELECT MAX("pageEnd") AS max_page
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1`,
    paramExtractor: () => [],
    formatFn: (rows) =>
      `The script is approximately ${rows[0]?.max_page ?? 'unknown'} page(s).`,
  },
  {
    name: 'character_first_appearance',
    matchPatterns: [
      /when (?:does|did)\s+(\w+)\s+(?:first\s+)?(?:appear|enter|show up|come in)/i,
      /(\w+)(?:'s)?\s+first\s+(?:appearance|scene|entry)/i,
    ],
    sql: `SELECT MIN("sceneNumber") AS scene, MIN("pageStart") AS page
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1 AND $2 = ANY(characters)`,
    paramExtractor: (f) => [f.characters?.[0]?.toUpperCase()],
    formatFn: (rows, params) => {
      const r = rows[0];
      if (!r?.scene) return `${params[0]} was not found in the script.`;
      let s = `${params[0]} first appears in scene ${r.scene}`;
      if (r.page) s += ` (p. ${r.page})`;
      return s + '.';
    },
  },
  {
    name: 'character_last_appearance',
    matchPatterns: [
      /when (?:does|did)\s+(\w+)\s+last\s+(?:appear|show up)/i,
      /(\w+)(?:'s)?\s+last\s+(?:appearance|scene)/i,
    ],
    sql: `SELECT MAX("sceneNumber") AS scene, MAX("pageEnd") AS page
          FROM ai_schema.script_chunks
          WHERE "scriptId" = $1 AND $2 = ANY(characters)`,
    paramExtractor: (f) => [f.characters?.[0]?.toUpperCase()],
    formatFn: (rows, params) => {
      const r = rows[0];
      if (!r?.scene) return `${params[0]} was not found in the script.`;
      let s = `${params[0]} last appears in scene ${r.scene}`;
      if (r.page) s += ` (p. ${r.page})`;
      return s + '.';
    },
  },
];
