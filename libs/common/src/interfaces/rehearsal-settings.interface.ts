export type SilencePace = 'fast' | 'normal' | 'patient';

export const SILENCE_PACE_MULTIPLIERS: Record<SilencePace, number> = {
  fast: 0.6,
  normal: 1.0,
  patient: 1.6,
};

export type ThemeMode = 'preset' | 'custom';

export type ThemePreset =
  | 'green'
  | 'blue'
  | 'pink'
  | 'orange'
  | 'purple'
  | 'teal';

export type StartDelaySec = 0 | 3 | 5 | 10;

export type DetectionMode = 'AUTO' | 'LISTEN' | 'MANUAL';

export interface DisplayPreferences {
  theme: ThemeMode;
  themeColor: string;
  highlightColor?: string;
  fontSize: number;
  hideStageDirections: boolean;
  hideStartMarker: boolean;
  hideEntireScript: boolean;
  hideYourLines: boolean;
  firstLetterMnemonics: boolean;
  autoShowAnalytics: boolean;
  startDelaySec: StartDelaySec;
}

export interface SessionSettings {
  detectionMode: DetectionMode;
  /**
   * When true, the backend computes a loose content-word overlap at turn end
   * and emits an advisory `actor.line_mismatch` for wildly off-script reads.
   * Advisory only — never blocks or rewinds. When false, no overlap is computed.
   */
  wordTracking: boolean;
  autoRecord: boolean;
  loopMode: boolean;
}

export const DISPLAY_DEFAULTS: DisplayPreferences = {
  theme: 'preset',
  themeColor: 'green',
  fontSize: 14,
  hideStageDirections: false,
  hideStartMarker: false,
  hideEntireScript: false,
  hideYourLines: false,
  firstLetterMnemonics: false,
  autoShowAnalytics: true,
  startDelaySec: 5,
};

export const SESSION_DEFAULTS: SessionSettings = {
  detectionMode: 'AUTO',
  wordTracking: false,
  autoRecord: true,
  loopMode: false,
};

export const LOOP_MAX_ITERATIONS = 50;
