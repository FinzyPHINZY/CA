import type { DetectionMode } from '../interfaces/rehearsal-settings.interface';

/**
 * Normalize any persisted/inbound detection mode to the current set.
 * Legacy STRICT/LENIENT both collapse to AUTO (turn-model driven).
 * Unknown or missing values default to AUTO.
 */
export function normalizeDetectionMode(value: unknown): DetectionMode {
  if (value === 'LISTEN' || value === 'MANUAL' || value === 'AUTO') {
    return value;
  }
  return 'AUTO';
}
