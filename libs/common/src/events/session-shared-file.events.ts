// Session shared file lifecycle events. Emitted by core (SessionFilesService)
// and consumed by notifications (socket fanout) and ai_service (analysis dispatch).
//
// Socket events delivered on the existing `/session` namespace, room=rehearsalId.

export const SESSION_FILE_EVENTS = {
  // core → notifications: new file attached, fan out to participants.
  SHARED: 'session.file.shared',
  // core → notifications: analysis started, fan out so UI shows spinner.
  ANALYZING: 'session.file.analyzing',
  // core → notifications: analysis completed/failed/cached.
  ANALYZED: 'session.file.analyzed',
  // core → notifications: file deleted, fan out so UI removes from list.
  DELETED: 'session.file.deleted',
  // core → ai_service: parse + (optional) Gemini analysis request.
  ANALYSIS_REQUESTED: 'session.file.analysis.requested',
  // ai_service → core: analysis result for a queued request.
  ANALYSIS_RESULT: 'session.file.analysis.result',
} as const;

export type SessionFileEventPattern =
  (typeof SESSION_FILE_EVENTS)[keyof typeof SESSION_FILE_EVENTS];

// Socket.io event names the FE listens for. Kept distinct from the RMQ
// pattern strings above so we can refactor transport without breaking clients.
export const SESSION_FILE_SOCKET_EVENTS = {
  SHARED: 'session.file_shared',
  ANALYZING: 'session.file_analyzing',
  ANALYZED: 'session.file_analyzed',
  DELETED: 'session.file_deleted',
} as const;

export type SessionFileSocketEvent =
  (typeof SESSION_FILE_SOCKET_EVENTS)[keyof typeof SESSION_FILE_SOCKET_EVENTS];

// ── RMQ payload types ──────────────────────────────────────────────────────

// All broadcast events carry both rehearsalId and bookingId. The FE binds
// session-room state by bookingId (TeleprompterGateway room key), while
// rehearsalId is the canonical rehearsal identifier the FE may also need to
// disambiguate when it tracks multiple rehearsals concurrently.
export interface SessionFileSharedEvent {
  pattern: typeof SESSION_FILE_EVENTS.SHARED;
  rehearsalId: string;
  bookingId: string;
  sharedFileId: string;
  uploaderUserId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
}

export interface SessionFileAnalyzingEvent {
  pattern: typeof SESSION_FILE_EVENTS.ANALYZING;
  rehearsalId: string;
  bookingId: string;
  sharedFileId: string;
  requestedBy: string;
}

export interface SessionFileAnalyzedEvent {
  pattern: typeof SESSION_FILE_EVENTS.ANALYZED;
  rehearsalId: string;
  bookingId: string;
  sharedFileId: string;
  status: 'completed' | 'failed' | 'cached';
  error?: string;
}

export interface SessionFileDeletedEvent {
  pattern: typeof SESSION_FILE_EVENTS.DELETED;
  rehearsalId: string;
  bookingId: string;
  sharedFileId: string;
  deletedBy: string;
}

// core → ai_service. ai_service routes to script_parser, then optionally Gemini,
// then emits SESSION_FILE_EVENTS.ANALYSIS_RESULT back to core.
export interface SessionFileAnalysisRequestedEvent {
  pattern: typeof SESSION_FILE_EVENTS.ANALYSIS_REQUESTED;
  rehearsalId: string;
  sharedFileId: string;
  requestedBy: string;
  s3Key: string;
  fileName: string;
  extension: string;
  mimeType: string;
  contentHash: string;
}

// ai_service → core. Core updates the SessionSharedFile row + emits ANALYZED.
export interface SessionFileAnalysisResultEvent {
  pattern: typeof SESSION_FILE_EVENTS.ANALYSIS_RESULT;
  rehearsalId: string;
  sharedFileId: string;
  status: 'completed' | 'failed';
  result?: Record<string, any>;
  error?: string;
  completedAt: string;
}

export type SessionFileEvent =
  | SessionFileSharedEvent
  | SessionFileAnalyzingEvent
  | SessionFileAnalyzedEvent
  | SessionFileDeletedEvent
  | SessionFileAnalysisRequestedEvent
  | SessionFileAnalysisResultEvent;
