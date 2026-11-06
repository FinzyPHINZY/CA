import { normalizeDetectionMode } from './detection-mode.util';

describe('normalizeDetectionMode', () => {
  it('maps legacy STRICT to AUTO', () => {
    expect(normalizeDetectionMode('STRICT')).toBe('AUTO');
  });
  it('maps legacy LENIENT to AUTO', () => {
    expect(normalizeDetectionMode('LENIENT')).toBe('AUTO');
  });
  it('passes AUTO through', () => {
    expect(normalizeDetectionMode('AUTO')).toBe('AUTO');
  });
  it('passes LISTEN and MANUAL through', () => {
    expect(normalizeDetectionMode('LISTEN')).toBe('LISTEN');
    expect(normalizeDetectionMode('MANUAL')).toBe('MANUAL');
  });
  it('falls back to AUTO for unknown/undefined', () => {
    expect(normalizeDetectionMode(undefined)).toBe('AUTO');
    expect(normalizeDetectionMode('garbage')).toBe('AUTO');
  });
});
