export enum RecordingMode {
  AI_REHEARSAL = 'ai_rehearsal',
  READER_SESSION = 'reader_session',
  SOLO_TELEPROMPTER = 'solo_teleprompter',
  SELF_TAPE = 'self_tape',
}

export enum RecordingStatus {
  PENDING = 'pending',
  RECORDING = 'recording',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export enum RehearsalStatus {
  CREATED = 'CREATED',
  PREPARING = 'PREPARING',
  READY = 'READY',
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export enum RehearsalEventType {
  SESSION_CREATED = 'session_created',
  SESSION_PREPARING = 'session_preparing',
  SESSION_READY = 'session_ready',
  SESSION_STARTED = 'session_started',
  SESSION_COMPLETED = 'session_completed',
  SESSION_FAILED = 'session_failed',
  SESSION_CANCELLED = 'session_cancelled',
  LINE_STARTED = 'line_started',
  LINE_COMPLETED = 'line_completed',
  LINE_RETRIED = 'line_retried',
  LINE_SKIPPED = 'line_skipped',
  LINE_MISMATCH = 'line_mismatch',
  CUE_TRIGGERED = 'cue_triggered',
  PAUSE = 'pause',
  RESUME = 'resume',
  SHARED_FILE_ATTACHED = 'shared_file_attached',
  SHARED_FILE_DELETED = 'shared_file_deleted',
  SHARED_FILE_ANALYZE_REQUESTED = 'shared_file_analyze_requested',
  SHARED_FILE_ANALYZE_COMPLETED = 'shared_file_analyze_completed',
  SHARED_FILE_ANALYZE_FAILED = 'shared_file_analyze_failed',
  CUE_NO_MATCH = 'cue_no_match',
  CUE_DRIFT_RESET = 'cue_drift_reset',
  CUE_STUCK = 'cue_stuck',
  STALE_FINAL_DROPPED = 'stale_final_dropped',
  ACTOR_BUFFER_QUIET_RESET = 'actor_buffer_quiet_reset_with_rewind',
}

export enum AgoraSessionStatus {
  CREATED = 'created',
  ACTIVE = 'active',
  RECORDING = 'recording',
  ENDED = 'ended',
}

export enum TranscodeStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum TranscodeVariant {
  ORIGINAL = 'original',
  HD_720P = '720p',
  AUDIO_ONLY = 'audio_only',
}

export enum UsageService {
  AGORA_MINUTES = 'agora_minutes',
  DEEPGRAM_MINUTES = 'deepgram_minutes',
  ELEVENLABS_CHARACTERS = 'elevenlabs_characters',
  GEMINI_TOKENS = 'gemini_tokens',
  S3_STORAGE_BYTES = 's3_storage_bytes',
}
