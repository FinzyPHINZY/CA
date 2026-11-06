/** biome-ignore-all lint/suspicious/noExplicitAny: private-method tests use partial fixtures */
import {
  RehearsalEventType,
  RehearsalMode,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Rehersal,
} from '@app/common';
import { DataSource } from 'typeorm';
import { RehearsalAnalyticsService } from './rehearsal-analytics.service';

describe('RehearsalAnalyticsService', () => {
  let service: RehearsalAnalyticsService;

  beforeEach(() => {
    service = new RehearsalAnalyticsService({} as DataSource);
  });

  it('should mark completed booked-reader rehearsals as 100% even without line events', () => {
    const rehearsal = {
      id: 'reh-1',
      mode: RehearsalMode.READER_BOOKED,
      runtimeEngine: RehearsalRuntimeEngine.STUDIO,
      status: RehearsalStatus.COMPLETED,
      createdAt: new Date('2026-03-13T08:55:00.000Z'),
      startedAt: new Date('2026-03-20T14:00:00.000Z'),
      endedAt: new Date('2026-03-20T14:30:00.000Z'),
      sessionDurationSeconds: 1800,
    } as Rehersal;

    const summary = (service as any).computeAnalyticsSummary(rehearsal, []);

    expect(summary.supportsLineAnalytics).toBe(false);
    expect(summary.totalActorLines).toBe(0);
    expect(summary.completionPct).toBe(100);
    expect(summary.lifecycleMilestones.completedAt).toBe(
      '2026-03-20T14:30:00.000Z',
    );
  });

  it('should preserve Hazel line-based completion metrics when line events exist', () => {
    const rehearsal = {
      id: 'reh-2',
      mode: RehearsalMode.AI,
      runtimeEngine: RehearsalRuntimeEngine.HAZEL,
      status: RehearsalStatus.ACTIVE,
      createdAt: new Date('2026-03-13T08:55:00.000Z'),
      startedAt: new Date('2026-03-20T14:00:00.000Z'),
      endedAt: null,
      sessionDurationSeconds: null,
    } as Rehersal;

    const events = [
      {
        rehearsalId: 'reh-2',
        eventType: RehearsalEventType.LINE_STARTED,
        lineIndex: 0,
        characterId: 'char-1',
        data: { text: 'Hello there' },
        timestamp: new Date('2026-03-20T14:00:05.000Z'),
      },
      {
        rehearsalId: 'reh-2',
        eventType: RehearsalEventType.LINE_COMPLETED,
        lineIndex: 0,
        characterId: 'char-1',
        data: { responseTimeMs: 900 },
        timestamp: new Date('2026-03-20T14:00:06.000Z'),
      },
    ];

    const summary = (service as any).computeAnalyticsSummary(rehearsal, events);

    expect(summary.supportsLineAnalytics).toBe(true);
    expect(summary.totalActorLines).toBe(1);
    expect(summary.completionPct).toBe(100);
    expect(summary.avgResponseTimeMs).toBe(900);
  });

  describe('P5 detection-quality fields', () => {
    const baseRehearsal = (): Rehersal =>
      ({
        id: 'reh-p5',
        mode: RehearsalMode.AI,
        runtimeEngine: RehearsalRuntimeEngine.HAZEL,
        status: RehearsalStatus.ACTIVE,
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
        startedAt: new Date('2026-05-21T10:00:05.000Z'),
        endedAt: null,
        sessionDurationSeconds: null,
      }) as Rehersal;

    it('counts CUE_NO_MATCH per line as retries and exposes attempt counts', () => {
      const events = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 4,
          data: { text: 'A long line', characterName: 'Eryn', mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:10.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 4,
          data: { transcript: 'garbled one', mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:11.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 4,
          data: { transcript: 'garbled two', mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:12.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_COMPLETED,
          lineIndex: 4,
          data: { responseTimeMs: 4200, mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:13.000Z'),
        },
      ];

      const summary = (service as any).computeAnalyticsSummary(
        baseRehearsal(),
        events,
      );

      expect(summary.linesWithRetries).toBe(1);
      expect(summary.linesCompletedFirstAttempt).toBe(0);
      expect(summary.attemptCountPerLine).toEqual([
        { lineIndex: 4, attempts: 2 },
      ]);
      expect(summary.retriesPerLine).toEqual([{ lineIndex: 4, retryCount: 2 }]);
      expect(summary.schemaVersion).toBe(3);
    });

    it('aggregates cue.stuck, drift, quiet-reset, and stale-final counters', () => {
      const events = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 1,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_STUCK,
          lineIndex: 1,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:05.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_SKIPPED,
          lineIndex: 1,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:07.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 2,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:08.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_DRIFT_RESET,
          lineIndex: 2,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:09.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.ACTOR_BUFFER_QUIET_RESET,
          lineIndex: 2,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:10.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.STALE_FINAL_DROPPED,
          lineIndex: null,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:11.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.STALE_FINAL_DROPPED,
          lineIndex: null,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:12.000Z'),
        },
      ];

      const summary = (service as any).computeAnalyticsSummary(
        baseRehearsal(),
        events,
      );

      expect(summary.linesStuck).toBe(1);
      expect(summary.linesDriftReset).toBe(1);
      expect(summary.linesQuietReset).toBe(1);
      expect(summary.linesSkippedAfterStuck).toBe(1);
      expect(summary.staleFinalDropCount).toBe(2);
    });

    it('does NOT credit the funnel when a LINE_SKIPPED arrives long after CUE_STUCK', () => {
      const events = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_STUCK,
          lineIndex: 7,
          data: { mode: 'LENIENT' },
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_SKIPPED,
          lineIndex: 7,
          data: { mode: 'LENIENT' },
          // > 10s after stuck event
          timestamp: new Date('2026-05-21T10:00:20.000Z'),
        },
      ];

      const summary = (service as any).computeAnalyticsSummary(
        baseRehearsal(),
        events,
      );

      expect(summary.linesSkippedAfterStuck).toBe(0);
    });

    it('computes matchRatio percentiles + trigger-type breakdown from CUE_TRIGGERED', () => {
      const ratios = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0];
      const events = ratios.map((r, i) => ({
        rehearsalId: 'reh-p5',
        eventType: RehearsalEventType.CUE_TRIGGERED,
        lineIndex: i,
        data: {
          matchRatio: r,
          triggerType: i % 2 === 0 ? 'word_overlap' : 'silence',
          mode: 'STRICT',
        },
        timestamp: new Date(`2026-05-21T10:00:${10 + i}.000Z`),
      }));

      const summary = (service as any).computeAnalyticsSummary(
        baseRehearsal(),
        events,
      );

      expect(summary.avgMatchRatio).toBeCloseTo(0.731, 2);
      expect(summary.matchRatioP50).toBeCloseTo(0.8, 2);
      expect(summary.matchRatioP90).toBeCloseTo(1.0, 2);
      expect(summary.triggerTypeBreakdown).toEqual({
        word_overlap: 4,
        line_progress_fallback: 0,
        silence: 4,
        manual_advance: 0,
      });
      expect(summary.byMode.STRICT?.avgMatchRatio).toBeCloseTo(0.731, 2);
      expect(summary.byMode.STRICT?.triggerTypeBreakdown.word_overlap).toBe(4);
    });

    it('produces difficult-lines scored from new signals, retryCount mirrors noMatchAttempts', async () => {
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 3,
          characterId: 'char-eryn',
          data: { text: 'Hard line', characterName: 'Eryn' },
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 3,
          data: { transcript: 'attempt 1' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_STUCK,
          lineIndex: 3,
          data: {},
          timestamp: new Date('2026-05-21T10:00:02.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_COMPLETED,
          lineIndex: 3,
          data: { responseTimeMs: 3000 },
          timestamp: new Date('2026-05-21T10:00:05.000Z'),
        },
      ];

      const fakeRehearsal = baseRehearsal();
      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(fakeRehearsal);
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');

      expect(result.data).toHaveLength(1);
      const line = result.data[0];
      expect(line.lineIndex).toBe(3);
      expect(line.noMatchAttempts).toBe(1);
      expect(line.stuckCount).toBe(1);
      expect(line.retryCount).toBe(1); // legacy field == noMatchAttempts
      expect(line.transcriptAttempts).toEqual(['attempt 1']);
      // 1*2 + 1*3 + 0 + 0 + 3000/1000 = 8
      expect(line.score).toBe(8);
    });

    it('surfaces characterId + resolved text/name + flags on difficult lines (Phase 2)', async () => {
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 8,
          characterId: 'char-mara',
          data: { text: 'I need a little badge', characterName: 'MARA' },
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 8,
          characterId: 'char-mara',
          data: { transcript: 'I need a little bag' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(baseRehearsal());
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(line.characterId).toBe('char-mara');
      expect(line.text).toBe('I need a little badge');
      expect(line.characterName).toBe('MARA');
      expect(line.textResolved).toBe(true);
      expect(line.characterResolved).toBe(true);
    });

    it('backfills line identity from a non-LINE event when LINE_STARTED lacks it', async () => {
      // Simulates a line whose LINE_STARTED carried no text (pre-enrichment)
      // but a later enriched CUE_NO_MATCH did — fillIdentity should resolve it.
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 2,
          data: {},
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 2,
          characterId: 'char-x',
          data: { text: 'Resolved here', characterName: 'X', transcript: 'no' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(baseRehearsal());
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(line.text).toBe('Resolved here');
      expect(line.characterName).toBe('X');
      expect(line.characterId).toBe('char-x');
      expect(line.textResolved).toBe(true);
    });

    it('resolves text/character from the durable sequence snapshot when events lack it', async () => {
      // Pre-Phase-2 style events: no text/characterName on the event payload.
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 8,
          data: {},
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 8,
          data: { transcript: 'garbled' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const rehearsalWithSnapshot = {
        ...baseRehearsal(),
        metaData: {
          sequenceSnapshot: [
            {
              index: 8,
              type: 'actor',
              characterId: 'char-snap',
              characterName: 'MARA',
              text: 'Snapshot resolved line',
            },
          ],
        },
      } as any;

      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(rehearsalWithSnapshot);
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(line.text).toBe('Snapshot resolved line');
      expect(line.characterName).toBe('MARA');
      expect(line.characterId).toBe('char-snap');
      expect(line.textResolved).toBe(true);
      expect(line.characterResolved).toBe(true);
    });

    it('prefers event-enriched identity over the snapshot', async () => {
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 8,
          characterId: 'char-event',
          data: { text: 'Event text wins', characterName: 'EVENT' },
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 8,
          data: { transcript: 'x' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const rehearsalWithSnapshot = {
        ...baseRehearsal(),
        metaData: {
          sequenceSnapshot: [
            {
              index: 8,
              type: 'actor',
              characterId: 'char-snap',
              characterName: 'SNAP',
              text: 'Snapshot text loses',
            },
          ],
        },
      } as any;

      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(rehearsalWithSnapshot);
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(line.text).toBe('Event text wins');
      expect(line.characterName).toBe('EVENT');
      expect(line.characterId).toBe('char-event');
    });

    it('resolves characterName for historical lines via Character lookup (Phase 4)', async () => {
      // Old rehearsal: characterId on the event column, but no characterName
      // anywhere (no enrichment, no snapshot). Resolve from Character entity.
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 8,
          characterId: 'char-old',
          data: {},
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 8,
          characterId: 'char-old',
          data: { transcript: 'x' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const findMock = jest
        .fn()
        .mockResolvedValue([{ id: 'char-old', name: 'HISTORIC' }]);
      const fakeService = service as any;
      fakeService.dataSource = { getRepository: () => ({ find: findMock }) };
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(baseRehearsal());
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(findMock).toHaveBeenCalledTimes(1);
      expect(line.characterId).toBe('char-old');
      expect(line.characterName).toBe('HISTORIC');
      expect(line.characterResolved).toBe(true);
      // text has no durable source for old data — stays honestly null.
      expect(line.text).toBeNull();
      expect(line.textResolved).toBe(false);
    });

    it('skips the Character query when no line needs a name (no DB hit)', async () => {
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 3,
          characterId: 'char-eryn',
          data: { text: 'Hard line', characterName: 'Eryn' },
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 3,
          data: { transcript: 'x' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const findMock = jest.fn();
      const fakeService = service as any;
      fakeService.dataSource = { getRepository: () => ({ find: findMock }) };
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(baseRehearsal());
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      await service.getDifficultLines('reh-p5', 'user-1');

      expect(findMock).not.toHaveBeenCalled();
    });

    it('caps transcriptAttempts count and length (PII hygiene, Phase 5)', async () => {
      const long = 'word '.repeat(100); // ~500 chars
      const fixtures = Array.from({ length: 6 }, (_, i) => ({
        rehearsalId: 'reh-p5',
        eventType: RehearsalEventType.CUE_NO_MATCH,
        lineIndex: 1,
        data: { transcript: `${i} ${long}` },
        timestamp: new Date(`2026-05-21T10:00:0${i}.000Z`),
      }));

      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(baseRehearsal());
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(line.noMatchAttempts).toBe(6);
      expect(line.transcriptAttempts.length).toBe(5); // capped count
      for (const t of line.transcriptAttempts) {
        expect(t.length).toBeLessThanOrEqual(300); // capped length
      }
    });

    it('redactExpiredTranscripts strips transcript from old rows', async () => {
      const execMock = jest.fn().mockResolvedValue({ affected: 3 });
      const qb: any = {
        update: () => qb,
        set: () => qb,
        where: () => qb,
        andWhere: () => qb,
        execute: execMock,
      };
      const fakeService = service as any;
      fakeService.dataSource = {
        getRepository: () => ({ createQueryBuilder: () => qb }),
      };

      const affected = await service.redactExpiredTranscripts(1000);

      expect(affected).toBe(3);
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('reports unresolved identity honestly as null (never "")', async () => {
      const fixtures = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 5,
          data: {},
          timestamp: new Date('2026-05-21T10:00:00.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.CUE_NO_MATCH,
          lineIndex: 5,
          data: { transcript: 'something' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
      ];

      const fakeService = service as any;
      fakeService.loadAndValidateRehearsal = jest
        .fn()
        .mockResolvedValue(baseRehearsal());
      fakeService.loadEvents = jest.fn().mockResolvedValue(fixtures);

      const result = await service.getDifficultLines('reh-p5', 'user-1');
      const line = result.data[0];

      expect(line.text).toBeNull();
      expect(line.characterName).toBeNull();
      expect(line.characterId).toBeNull();
      expect(line.textResolved).toBe(false);
      expect(line.characterResolved).toBe(false);
    });

    it('handles AUTO-mode rehearsals (new turn-taking engine) without crash or NaN', () => {
      // New engine emits LINE_STARTED/LINE_COMPLETED with mode:'AUTO' and no
      // matcher events (CUE_NO_MATCH, CUE_STUCK, etc. are never emitted).
      // Analytics must degrade gracefully: detection-quality fields → null/0,
      // byMode populated under the 'AUTO' key, no division-by-zero.
      const events = [
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 0,
          characterId: 'char-auto',
          data: { text: 'First line', characterName: 'ACE', mode: 'AUTO' },
          timestamp: new Date('2026-05-21T10:00:01.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_COMPLETED,
          lineIndex: 0,
          characterId: 'char-auto',
          data: {
            transcript: 'First line',
            trigger: 'turn_end',
            mode: 'AUTO',
          },
          timestamp: new Date('2026-05-21T10:00:03.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_STARTED,
          lineIndex: 1,
          characterId: 'char-auto',
          data: { text: 'Second line', characterName: 'ACE', mode: 'AUTO' },
          timestamp: new Date('2026-05-21T10:00:05.000Z'),
        },
        {
          rehearsalId: 'reh-p5',
          eventType: RehearsalEventType.LINE_SKIPPED,
          lineIndex: 1,
          data: { mode: 'AUTO' },
          timestamp: new Date('2026-05-21T10:00:07.000Z'),
        },
      ];

      const summary = (service as any).computeAnalyticsSummary(
        baseRehearsal(),
        events,
      );

      // Basic line counts — must not be NaN or throw.
      expect(summary.supportsLineAnalytics).toBe(true);
      expect(summary.totalActorLines).toBe(2);
      expect(summary.completionPct).toBe(50);
      expect(summary.linesSkipped).toBe(1);

      // Detection-quality fields degrade gracefully when matcher events absent.
      expect(summary.linesStuck).toBe(0);
      expect(summary.linesDriftReset).toBe(0);
      expect(summary.linesQuietReset).toBe(0);
      expect(summary.staleFinalDropCount).toBe(0);
      expect(summary.linesSkippedAfterStuck).toBe(0);
      expect(summary.avgMatchRatio).toBeNull();
      expect(summary.matchRatioP50).toBeNull();
      expect(summary.matchRatioP90).toBeNull();
      expect(summary.linesWithRetries).toBe(0);
      expect(summary.linesCompletedFirstAttempt).toBe(1);

      // AUTO mode is now recognised and bucketed in byMode.
      expect(summary.byMode.AUTO).toBeDefined();
      expect(summary.byMode.AUTO.totalLines).toBe(2);
      expect(summary.byMode.AUTO.linesAdvanced).toBe(1);
      expect(summary.byMode.AUTO.linesStuck).toBe(0);
      expect(summary.byMode.AUTO.avgMatchRatio).toBeNull();

      // Historical LENIENT/STRICT entries must NOT appear for a pure AUTO rehearsal.
      expect(summary.byMode.LENIENT).toBeUndefined();
      expect(summary.byMode.STRICT).toBeUndefined();
    });
  });
});
