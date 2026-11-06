export interface ScriptParserElement {
  type: string;
  text: string;
  character_name?: string | null;
  delivery?: string | null;
  revised?: boolean;
}

export interface ScriptParserScene {
  number: number;
  script_scene_number?: string | null;
  heading: string;
  location?: string | null;
  time_of_day?: string | null;
  interior_exterior?: string | null;
  elements: ScriptParserElement[];
  page_start?: number | null;
  page_end?: number | null;
}

export interface ScriptParserCharacter {
  name: string;
  line_count: number;
}

export interface ScriptParserNativeExtractionBlock {
  text: string;
  page: number;
  bounding_box: number[];
  attributes: Record<string, unknown>;
}

export interface ScriptParserNativeExtractionPayload {
  source: 'pymupdf_native_pdf';
  blocks: ScriptParserNativeExtractionBlock[];
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface ScriptParserResultPayload {
  title?: string | null;
  format: string;
  scenes: ScriptParserScene[];
  characters: ScriptParserCharacter[];
  raw_text: string;
  clean_text: string;
  page_count: number;
  structure_confidence_score: number;
  watermark_detected: boolean;
  watermark_texts: string[];
  stage_play_detected: boolean;
  parser_warnings: string[];
  low_confidence_flag: boolean;
}

export interface ScriptParserResultMessage {
  task_id: string;
  script_id: string;
  user_id: string;
  status: 'SUCCESS' | 'VALIDATION_FAILED' | 'PARSE_FAILED' | 'NEEDS_OCR';
  error?: string | null;
  message?: string | null;
  confidence_score?: number | null;
  result?: ScriptParserResultPayload | null;
  native_extraction?: ScriptParserNativeExtractionPayload | null;
  file_name?: string | null;
  project_id?: string | null;
  script_index?: number | null;
  content_hash?: string | null;
  /** Media URL passed back for NEEDS_OCR so ai_service can download the file. */
  media_url?: string | null;
  /** Phase 0 observability: parser whose output is in `result`. */
  parser_path?: string | null;
  /** Phase 0 observability: ordered list of every parser attempted (including fallbacks). */
  parser_chain?: string[];
}
