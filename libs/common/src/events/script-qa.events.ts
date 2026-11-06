export const SCRIPT_QA_EVENTS = {
  SCRIPT_EMBED: 'script.embed',
  QA_PREPARE: 'qa.prepare',
  QA_ASK: 'qa.ask',
} as const;

export interface ScriptEmbedEvent {
  scriptId: string;
  userId: string;
  contentHash: string | null;
}
