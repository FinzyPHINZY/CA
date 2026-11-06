/** biome-ignore-all lint/suspicious/noExplicitAny: test fixtures are partial */
import { SilenceDetectionService } from './silence-detection.service';

describe('SilenceDetectionService', () => {
  let service: SilenceDetectionService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new SilenceDetectionService({
      get: jest.fn((key: string, fallback: number) => {
        if (key === 'HAZEL_SILENCE_THRESHOLD_MS') return 5000;
        if (key === 'HAZEL_SILENCE_MIN_MATCH_RATIO') return 0.6;
        return fallback;
      }),
    } as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should not advance on silence when accumulated match is below the configured threshold', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 3, lineBucket: 'short' });

    service.onTranscriptReceived(
      'reh-1',
      0.45,
      'I would love',
      true,
      false,
      onAdvance,
    );

    jest.advanceTimersByTime(5000);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('should advance on silence after a strong final transcript match', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 3, lineBucket: 'short' });

    service.onTranscriptReceived(
      'reh-1',
      0.68,
      'I would love to keep saying yes',
      true,
      true,
      onAdvance,
    );

    jest.advanceTimersByTime(5000);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('should advance on silence for non-final transcripts only after substantial accumulated speech', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 6, lineBucket: 'medium' });

    service.onTranscriptReceived(
      'reh-1',
      0.74,
      'I would love to keep saying yes',
      false,
      true,
      onAdvance,
    );

    jest.advanceTimersByTime(5000);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('should not advance on silence for short non-final fragments even when match is strong', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 6, lineBucket: 'medium' });

    service.onTranscriptReceived(
      'reh-1',
      0.7,
      'I would love',
      false,
      false,
      onAdvance,
    );

    jest.advanceTimersByTime(5000);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('should not advance a long line on silence without tail coverage', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 10, lineBucket: 'long' });

    service.onTranscriptReceived(
      'reh-1',
      0.85,
      'I would love to keep saying yes',
      true,
      false,
      onAdvance,
    );

    jest.advanceTimersByTime(10000);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('schedules stale-match auto-advance on long lines when matchRatio clears the 0.6 floor and tailCoverage is set', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 10, lineBucket: 'long' });

    service.onTranscriptReceived(
      'reh-1',
      0.9,
      'I would love to keep saying yes and before I know it now tonight',
      false,
      true,
      onAdvance,
    );

    // dynamicStaleMs at wordCount=10 = baseStaleMs (2000ms) under normal pace.
    jest.advanceTimersByTime(2001);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('still rejects long-line stale-match when matchRatio is below the 0.6 floor', () => {
    const onAdvance = jest.fn();
    service.onActorTurnStart('reh-1', { wordCount: 10, lineBucket: 'long' });

    service.onTranscriptReceived(
      'reh-1',
      0.5,
      'I would love to keep saying yes',
      false,
      true,
      onAdvance,
    );

    jest.advanceTimersByTime(3000);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  describe('silencePace multiplier', () => {
    it('fires earlier under fast pace (multiplier 0.6)', () => {
      const onAdvance = jest.fn();
      service.onActorTurnStart('reh-1', {
        wordCount: 3,
        lineBucket: 'short',
        silencePace: 'fast',
      });

      service.onTranscriptReceived(
        'reh-1',
        0.68,
        'I would love to keep saying yes',
        true,
        true,
        onAdvance,
      );

      jest.advanceTimersByTime(2999);
      expect(onAdvance).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2);
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    it('fires later under patient pace (multiplier 1.6)', () => {
      const onAdvance = jest.fn();
      service.onActorTurnStart('reh-1', {
        wordCount: 3,
        lineBucket: 'short',
        silencePace: 'patient',
      });

      service.onTranscriptReceived(
        'reh-1',
        0.68,
        'I would love to keep saying yes',
        true,
        true,
        onAdvance,
      );

      jest.advanceTimersByTime(7999);
      expect(onAdvance).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2);
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });

    it('matches normal pace baseline when silencePace omitted', () => {
      const onAdvance = jest.fn();
      service.onActorTurnStart('reh-1', { wordCount: 3, lineBucket: 'short' });

      service.onTranscriptReceived(
        'reh-1',
        0.68,
        'I would love to keep saying yes',
        true,
        true,
        onAdvance,
      );

      jest.advanceTimersByTime(4999);
      expect(onAdvance).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2);
      expect(onAdvance).toHaveBeenCalledTimes(1);
    });
  });
});
