// hazel recording lifecycle events — emitted by ai_service (HazelRecordingService)
// and consumed by core (HazelRecordingConsumer). RabbitMQ pattern strings live in
// HAZEL_RECORDING_EVENTS so @EventPattern decorators stay in sync with emitters.

export const HAZEL_RECORDING_EVENTS = {
  STARTED: 'hazel.recording.started',
  STOP_REQUESTED: 'hazel.recording.stop_requested',
  COMPLETED: 'hazel.recording.completed',
  FAILED: 'hazel.recording.failed',
} as const;

export type HazelRecordingEventPattern =
  (typeof HAZEL_RECORDING_EVENTS)[keyof typeof HAZEL_RECORDING_EVENTS];

// emitted after Agora cloud_recording/acquire + /start succeed.
// core creates a Recording row (status=RECORDING) keyed by rehearsalId.
export interface HazelRecordingStartedEvent {
  pattern: 'hazel.recording.started';
  rehearsalId: string;
  userId: string;
  agoraChannelId: string;
  agoraResourceId: string;
  agoraSid: string;
  startedAt: string;
}

// emitted when the user ends a Hazel session that had recording active.
// core owns the Agora /stop call + finalization → Recording row update.
export interface HazelRecordingStopRequestedEvent {
  pattern: 'hazel.recording.stop_requested';
  rehearsalId: string;
  userId: string;
  agoraResourceId: string;
  agoraSid: string;
  agoraChannelId: string;
  stoppedAt: string;
}

// emitted by core after Agora /stop returns fileList → Recording row marked READY.
// notifications service forwards to the user (existing 'recording.ready' downstream).
export interface HazelRecordingCompletedEvent {
  pattern: 'hazel.recording.completed';
  rehearsalId: string;
  recordingId: string;
  userId: string;
  fileCount: number;
  completedAt: string;
}

// emitted whenever any step in the recording lifecycle fails terminally.
// core marks Recording row FAILED with reason in metaData.
export interface HazelRecordingFailedEvent {
  pattern: 'hazel.recording.failed';
  rehearsalId: string;
  userId: string;
  stage: 'start' | 'stop' | 'finalize';
  reason: string;
  failedAt: string;
}

export type HazelRecordingEvent =
  | HazelRecordingStartedEvent
  | HazelRecordingStopRequestedEvent
  | HazelRecordingCompletedEvent
  | HazelRecordingFailedEvent;
