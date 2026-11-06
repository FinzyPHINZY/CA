/** biome-ignore-all lint/suspicious/noExplicitAny: analytics data is heterogeneous */
import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  RehearsalEvent,
  RehearsalEventType,
  RehearsalMode,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Project,
  Rehersal,
  Character,
  REHEARSAL_SEQUENCE_SNAPSHOT_KEY,
  type RehearsalSequenceSnapshotEntry,
} from '@app/common';

export interface RehearsalLifecycleMilestones {
  createdAt: string | null;
  preparingAt: string | null;
  readyAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  resumedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export type RehearsalDetectionMode =
  | 'AUTO'
  | 'LENIENT'
  | 'STRICT'
  | 'MANUAL'
  | 'LISTEN';

export type CueTriggerType =
  | 'word_overlap'
  | 'line_progress_fallback'
  | 'silence'
  | 'manual_advance';

export interface CueTriggerTypeBreakdown {
  word_overlap: number;
  line_progress_fallback: number;
  silence: number;
  manual_advance: number;
}

/**
 * Per-mode subset of detection-quality fields. Populated only for modes
 * the actor used in this rehearsal — entries are omitted otherwise, so
 * consumers should treat absence as "not exercised".
 */
export interface RehearsalAnalyticsByMode {
  totalLines: number;
  linesAdvanced: number;
  linesStuck: number;
  linesDriftReset: number;
  avgMatchRatio: number | null;
  triggerTypeBreakdown: CueTriggerTypeBreakdown;
}

export interface RehearsalAnalyticsSummary {
  schemaVersion: number;
  rehearsalId: string;
  computedAt: string;
  mode: RehearsalMode;
  runtimeEngine: RehearsalRuntimeEngine;
  supportsLineAnalytics: boolean;
  totalActorLines: number;
  linesCompletedFirstAttempt: number;
  linesWithRetries: number;
  retriesPerLine: Array<{ lineIndex: number; retryCount: number }>;
  avgResponseTimeMs: number | null;
  slowestResponseTimeMs: number | null;
  fastestResponseTimeMs: number | null;
  sessionDurationMs: number | null;
  activeDurationMs: number | null;
  pausedDurationMs: number;
  linesSkipped: number;
  completionPct: number;
  lifecycleMilestones: RehearsalLifecycleMilestones;
  // P5 additions — detection-quality + new event signal aggregates.
  // `linesWithRetries` semantics changed: previously always 0 (built on
  // never-emitted LINE_RETRIED); now reflects unique lines that had any
  // CUE_NO_MATCH event. Same for linesCompletedFirstAttempt.
  attemptCountPerLine: Array<{ lineIndex: number; attempts: number }>;
  linesStuck: number;
  linesDriftReset: number;
  linesQuietReset: number;
  linesSkippedAfterStuck: number;
  staleFinalDropCount: number;
  avgMatchRatio: number | null;
  matchRatioP50: number | null;
  matchRatioP90: number | null;
  triggerTypeBreakdown: CueTriggerTypeBreakdown;
  byMode: Partial<Record<RehearsalDetectionMode, RehearsalAnalyticsByMode>>;
}

export interface DifficultLine {
  lineIndex: number;
  /**
   * Script line text. `null` when the source event did not carry it (events
   * historically persisted only structural pointers — see the data-fix plan).
   * `""` is never used as a stand-in for "unknown". Resolution improves once
   * write-time enrichment (Phase 2) + sequence snapshot (Phase 3) land.
   */
  text: string | null;
  characterName: string | null;
  /** Character UUID from the event column. Present even when name/text are not. */
  characterId: string | null;
  score: number;
  /**
   * Legacy field. After P5: equals noMatchAttempts (count of CUE_NO_MATCH
   * events for this line). Old definition relied on the never-emitted
   * LINE_RETRIED so this value used to be always 0.
   */
  retryCount: number;
  avgResponseTimeMs: number;
  transcriptAttempts: string[];
  // P5 additions.
  noMatchAttempts: number;
  stuckCount: number;
  driftResetCount: number;
  quietResetCount: number;
  /** True when `text` was resolved from event/snapshot data; false = unavailable. */
  textResolved: boolean;
  /** True when the character is known via `characterId` and/or `characterName`. */
  characterResolved: boolean;
}

export interface TimelineEntry {
  eventType: RehearsalEventType;
  lineIndex: number | null;
  characterId: string | null;
  timestamp: string;
  offsetMs: number;
  data: Record<string, any> | null;
}

export interface SceneProgress {
  sceneId: string;
  attemptCount: number;
  lastRehearsalDate: string | null;
}

export interface SceneImprovementSession {
  rehearsalId: string;
  date: string;
  avgResponseTimeMs: number | null;
}

export interface SceneImprovementTrend {
  sceneId: string;
  sessions: SceneImprovementSession[];
}

export interface MatchQualitySession {
  rehearsalId: string;
  date: string;
  avgMatchRatio: number | null;
}

export interface StuckRateSession {
  rehearsalId: string;
  date: string;
  /** linesStuck / totalActorLines, 0–1 */
  stuckRate: number;
  totalActorLines: number;
  linesStuck: number;
}

export interface CharacterDifficulty {
  characterName: string;
  avgDifficultyScore: number;
  totalDifficultLines: number;
}

export interface ProjectProgress {
  schemaVersion: number;
  projectId: string;
  computedAt: string;
  scenesPracticed: SceneProgress[];
  totalRehearsalTimeMs: number;
  improvementTrend: SceneImprovementTrend[];
  charactersPracticed: string[];
  lastRehearsalDatePerScene: Record<string, string>;
  currentStreakDays: number;
  // P5 additions.
  matchQualityTrend: MatchQualitySession[];
  stuckRateTrend: StuckRateSession[];
  charactersDifficulty: CharacterDifficulty[];
}

export interface SceneComparisonSession {
  rehearsalId: string;
  date: string;
  avgResponseTimeMs: number | null;
  retryRate: number;
  completionPct: number;
}

export interface SceneComparisonResult {
  sceneId: string;
  sessions: SceneComparisonSession[];
}

interface PerLineAgg {
  // null = unknown (not yet resolvable from the event stream). Never "".
  lineText: string | null;
  characterName: string | null;
  characterId: string | null;
  noMatchAttempts: number;
  stuckCount: number;
  driftResetCount: number;
  quietResetCount: number;
  responseTimes: number[];
  noMatchTranscripts: string[];
}

interface ByModeAgg {
  lineIndices: Set<number>;
  advancedLineIndices: Set<number>;
  stuckLineIndices: Set<number>;
  driftLineIndices: Set<number>;
  matchRatios: number[];
  triggerTypes: CueTriggerTypeBreakdown;
}

interface EventAggregate {
  perLine: Map<number, PerLineAgg>;
  completedLineIndices: Set<number>;
  startedLineIndices: Set<number>;
  skippedLineIndices: Set<number>;
  pauseTs: number[];
  resumeTs: number[];
  matchRatioSamples: number[];
  triggerTypeCounts: CueTriggerTypeBreakdown;
  staleFinalDropCount: number;
  linesSkippedAfterStuck: number;
  byMode: Map<RehearsalDetectionMode, ByModeAgg>;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
/**
 * Bumped to 2 in P5: added detection-quality fields (linesStuck,
 * matchRatio percentiles, byMode, etc.) plus semantic shift of
 * linesWithRetries / linesCompletedFirstAttempt (LINE_RETRIED →
 * CUE_NO_MATCH). Cached entries with schemaVersion < CURRENT are
 * force-recomputed.
 */
const REHEARSAL_ANALYTICS_SCHEMA_VERSION = 3;
/**
 * Bumped to 3 (data-fix Phase 4): project progress now resolves
 * `charactersDifficulty` names from the durable sequence snapshot + Character
 * lookup instead of collapsing unresolved lines to "Unknown". Cached entries
 * below CURRENT are lazily recomputed on next read (and by the nightly cron),
 * so historical projects self-heal without a manual backfill.
 *
 * NOTE: the rehearsal-analytics summary version is intentionally NOT bumped —
 * its cached shape/content is unchanged by the data fix (difficult-lines, the
 * endpoint that carries line text, is uncached and always recomputed).
 */
const PROJECT_PROGRESS_SCHEMA_VERSION = 3;
/** Window after a CUE_STUCK event during which a LINE_SKIPPED counts as the funnel resolution. */
const STUCK_TO_SKIP_WINDOW_MS = 10_000;

// ── Transcript hygiene (Phase 5) ─────────────────────────────────────────
// Transcripts are raw user speech (PII). Cap what leaves in difficult-lines
// and age-out the raw text from old event rows while keeping the structural
// counts analytics needs.
/** Max transcript attempts returned per difficult line. */
const MAX_TRANSCRIPT_ATTEMPTS = 5;
/** Max characters per returned transcript attempt. */
const MAX_TRANSCRIPT_LENGTH = 300;
/** Days after which raw transcript text is stripped from RehearsalEvent rows. */
const TRANSCRIPT_RETENTION_DAYS =
  Number(process.env.REHEARSAL_TRANSCRIPT_RETENTION_DAYS) || 90;

function roundTo(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
const LIFECYCLE_EVENT_TYPES = new Set<RehearsalEventType>([
  RehearsalEventType.SESSION_CREATED,
  RehearsalEventType.SESSION_PREPARING,
  RehearsalEventType.SESSION_READY,
  RehearsalEventType.SESSION_STARTED,
  RehearsalEventType.PAUSE,
  RehearsalEventType.RESUME,
  RehearsalEventType.SESSION_COMPLETED,
  RehearsalEventType.SESSION_FAILED,
  RehearsalEventType.SESSION_CANCELLED,
]);

@Injectable()
export class RehearsalAnalyticsService {
  private readonly logger = new Logger(RehearsalAnalyticsService.name);

  constructor(private readonly dataSource: DataSource) {}

  async getRehearsalAnalytics(
    rehearsalId: string,
    userId: string,
  ): Promise<any> {
    const rehearsal = await this.loadAndValidateRehearsal(rehearsalId, userId);

    // serve from cache if less than 1 hour old AND on the current schema.
    // Stale-schema cache entries are recomputed to backfill the new fields.
    const cached = rehearsal.metaData?.analytics as
      | RehearsalAnalyticsSummary
      | undefined;
    const computedAt: string | undefined =
      rehearsal.metaData?.analyticsComputedAt;
    if (
      cached &&
      computedAt &&
      Date.now() - new Date(computedAt).getTime() < ONE_HOUR_MS &&
      cached.mode === rehearsal.mode &&
      cached.runtimeEngine === rehearsal.runtimeEngine &&
      (cached.schemaVersion ?? 0) === REHEARSAL_ANALYTICS_SCHEMA_VERSION
    ) {
      return {
        success: true,
        message: 'Rehearsal analytics retrieved successfully',
        data: cached,
      };
    }

    const summary = await this.computeAndCacheRehearsalAnalytics(rehearsal);
    return {
      success: true,
      message: 'Rehearsal analytics retrieved successfully',
      data: summary,
    };
  }

  async computeAndCacheRehearsalAnalytics(
    rehearsal: Rehersal,
  ): Promise<RehearsalAnalyticsSummary> {
    const events = await this.loadEvents(rehearsal.id);
    const summary = this.computeAnalyticsSummary(rehearsal, events);

    await this.dataSource
      .getRepository(Rehersal)
      .createQueryBuilder()
      .update()
      .set({
        metaData: () =>
          `COALESCE("metaData", '{}') || '${JSON.stringify({ analyticsComputedAt: summary.computedAt, analytics: summary })}'::jsonb`,
      })
      .where('id = :id', { id: rehearsal.id })
      .execute();

    this.logger.debug(`Analytics cached for rehearsal ${rehearsal.id}`);
    return summary;
  }

  /**
   * Single-pass aggregator over a rehearsal's event stream. Produces a
   * structured record consumed by computeAnalyticsSummary + getDifficultLines.
   * Replaces the prior approach of 5+ independent .filter() passes.
   */
  private aggregateEvents(events: RehearsalEvent[]): EventAggregate {
    const perLine = new Map<number, PerLineAgg>();
    const completedLineIndices = new Set<number>();
    const startedLineIndices = new Set<number>();
    const skippedLineIndices = new Set<number>();
    const pauseTs: number[] = [];
    const resumeTs: number[] = [];
    const matchRatioSamples: number[] = [];
    const triggerTypeCounts: CueTriggerTypeBreakdown = {
      word_overlap: 0,
      line_progress_fallback: 0,
      silence: 0,
      manual_advance: 0,
    };
    let staleFinalDropCount = 0;

    const byMode = new Map<RehearsalDetectionMode, ByModeAgg>();

    const getMode = (e: RehearsalEvent): RehearsalDetectionMode | null => {
      const m = e.data?.mode;
      if (
        m === 'AUTO' ||
        m === 'LENIENT' ||
        m === 'STRICT' ||
        m === 'MANUAL' ||
        m === 'LISTEN'
      ) {
        return m;
      }
      return null;
    };

    const ensureLine = (lineIndex: number): PerLineAgg => {
      let entry = perLine.get(lineIndex);
      if (!entry) {
        entry = {
          lineText: null,
          characterName: null,
          characterId: null,
          noMatchAttempts: 0,
          stuckCount: 0,
          driftResetCount: 0,
          quietResetCount: 0,
          responseTimes: [],
          noMatchTranscripts: [],
        };
        perLine.set(lineIndex, entry);
      }
      return entry;
    };

    // Backfill line identity (text / characterName / characterId) onto the
    // per-line aggregate from any event that carries it. After Phase 2 every
    // line-scoped event is enriched, so the first one wins regardless of type
    // (no longer reliant on LINE_STARTED/LINE_COMPLETED specifically).
    // `null` (never "") is the unknown sentinel — guarded by typeof checks.
    const fillIdentity = (entry: PerLineAgg, e: RehearsalEvent): void => {
      if (
        entry.lineText === null &&
        typeof e.data?.text === 'string' &&
        e.data.text.length > 0
      ) {
        entry.lineText = e.data.text;
      }
      if (
        entry.characterName === null &&
        typeof e.data?.characterName === 'string' &&
        e.data.characterName.length > 0
      ) {
        entry.characterName = e.data.characterName;
      }
      if (!entry.characterId && e.characterId) {
        entry.characterId = e.characterId;
      }
    };

    const ensureMode = (mode: RehearsalDetectionMode): ByModeAgg => {
      let entry = byMode.get(mode);
      if (!entry) {
        entry = {
          lineIndices: new Set<number>(),
          advancedLineIndices: new Set<number>(),
          stuckLineIndices: new Set<number>(),
          driftLineIndices: new Set<number>(),
          matchRatios: [],
          triggerTypes: {
            word_overlap: 0,
            line_progress_fallback: 0,
            silence: 0,
            manual_advance: 0,
          },
        };
        byMode.set(mode, entry);
      }
      return entry;
    };

    // collect stuck events ordered for the funnel computation below
    const stuckEvents: Array<{ lineIndex: number; ts: number }> = [];
    const skipEvents: Array<{ lineIndex: number; ts: number }> = [];

    for (const e of events) {
      const ts = new Date(e.timestamp).getTime();
      const mode = getMode(e);

      switch (e.eventType) {
        case RehearsalEventType.LINE_STARTED:
          if (e.lineIndex !== null) {
            startedLineIndices.add(e.lineIndex);
            fillIdentity(ensureLine(e.lineIndex), e);
            if (mode) ensureMode(mode).lineIndices.add(e.lineIndex);
          }
          break;

        case RehearsalEventType.LINE_COMPLETED:
          if (e.lineIndex !== null) {
            completedLineIndices.add(e.lineIndex);
            const entry = ensureLine(e.lineIndex);
            fillIdentity(entry, e);
            const rt = e.data?.responseTimeMs;
            if (typeof rt === 'number' && rt > 0) {
              entry.responseTimes.push(rt);
            }
            if (mode) ensureMode(mode).advancedLineIndices.add(e.lineIndex);
          }
          break;

        case RehearsalEventType.LINE_SKIPPED:
          if (e.lineIndex !== null) {
            skippedLineIndices.add(e.lineIndex);
            skipEvents.push({ lineIndex: e.lineIndex, ts });
          }
          break;

        case RehearsalEventType.CUE_NO_MATCH:
          if (e.lineIndex !== null) {
            const entry = ensureLine(e.lineIndex);
            fillIdentity(entry, e);
            entry.noMatchAttempts += 1;
            const t = e.data?.transcript;
            if (typeof t === 'string' && t.length > 0) {
              entry.noMatchTranscripts.push(t);
            }
          }
          break;

        case RehearsalEventType.CUE_STUCK:
          if (e.lineIndex !== null) {
            const entry = ensureLine(e.lineIndex);
            fillIdentity(entry, e);
            entry.stuckCount += 1;
            stuckEvents.push({ lineIndex: e.lineIndex, ts });
            if (mode) ensureMode(mode).stuckLineIndices.add(e.lineIndex);
          }
          break;

        case RehearsalEventType.CUE_DRIFT_RESET:
          if (e.lineIndex !== null) {
            const entry = ensureLine(e.lineIndex);
            fillIdentity(entry, e);
            entry.driftResetCount += 1;
            if (mode) ensureMode(mode).driftLineIndices.add(e.lineIndex);
          }
          break;

        case RehearsalEventType.ACTOR_BUFFER_QUIET_RESET:
          if (e.lineIndex !== null) {
            ensureLine(e.lineIndex).quietResetCount += 1;
          }
          break;

        case RehearsalEventType.STALE_FINAL_DROPPED:
          staleFinalDropCount += 1;
          break;

        case RehearsalEventType.CUE_TRIGGERED: {
          const r = e.data?.matchRatio;
          if (typeof r === 'number' && r >= 0 && r <= 1) {
            matchRatioSamples.push(r);
            if (mode) ensureMode(mode).matchRatios.push(r);
          }
          const tt = e.data?.triggerType;
          if (
            tt === 'word_overlap' ||
            tt === 'line_progress_fallback' ||
            tt === 'silence' ||
            tt === 'manual_advance'
          ) {
            triggerTypeCounts[tt] += 1;
            if (mode) ensureMode(mode).triggerTypes[tt] += 1;
          }
          break;
        }

        case RehearsalEventType.PAUSE:
          pauseTs.push(ts);
          break;

        case RehearsalEventType.RESUME:
          resumeTs.push(ts);
          break;
      }
    }

    // Funnel: for each CUE_STUCK event, find the earliest LINE_SKIPPED on
    // the same line within STUCK_TO_SKIP_WINDOW_MS. Each match credited once;
    // each skip can only resolve one stuck event (FIFO consumption).
    skipEvents.sort((a, b) => a.ts - b.ts);
    stuckEvents.sort((a, b) => a.ts - b.ts);
    const consumedSkipIdx = new Set<number>();
    let linesSkippedAfterStuck = 0;
    for (const stuck of stuckEvents) {
      for (let i = 0; i < skipEvents.length; i++) {
        if (consumedSkipIdx.has(i)) continue;
        const s = skipEvents[i];
        if (s.lineIndex !== stuck.lineIndex) continue;
        if (s.ts < stuck.ts) continue;
        if (s.ts - stuck.ts > STUCK_TO_SKIP_WINDOW_MS) continue;
        linesSkippedAfterStuck += 1;
        consumedSkipIdx.add(i);
        break;
      }
    }

    return {
      perLine,
      completedLineIndices,
      startedLineIndices,
      skippedLineIndices,
      pauseTs: pauseTs.sort((a, b) => a - b),
      resumeTs: resumeTs.sort((a, b) => a - b),
      matchRatioSamples,
      triggerTypeCounts,
      staleFinalDropCount,
      linesSkippedAfterStuck,
      byMode,
    };
  }

  /**
   * Durable fallback: fill any per-line identity (text / characterName /
   * characterId) still unresolved from the event stream using the immutable
   * sequence snapshot persisted on the rehearsal at build time. This survives
   * the Redis 4h TTL and is edit-proof against later scene changes.
   *
   * Resolution precedence is therefore: event-enriched (Phase 2 fillIdentity)
   * → snapshot (here) → null. Only fills nulls; never overwrites event data.
   */
  private applySnapshotFallback(
    perLine: Map<number, PerLineAgg>,
    rehearsal: Rehersal,
  ): void {
    const snapshot = rehearsal.metaData?.[REHEARSAL_SEQUENCE_SNAPSHOT_KEY] as
      | RehearsalSequenceSnapshotEntry[]
      | undefined;
    if (!Array.isArray(snapshot) || snapshot.length === 0) return;

    const byIndex = new Map<number, RehearsalSequenceSnapshotEntry>();
    for (const entry of snapshot) byIndex.set(entry.index, entry);

    for (const [lineIndex, entry] of perLine.entries()) {
      const snap = byIndex.get(lineIndex);
      if (!snap) continue;
      if (entry.lineText === null && snap.text) entry.lineText = snap.text;
      if (entry.characterName === null && snap.characterName) {
        entry.characterName = snap.characterName;
      }
      if (!entry.characterId && snap.characterId) {
        entry.characterId = snap.characterId;
      }
    }
  }

  /**
   * Last-resort character resolution for HISTORICAL data: lines that still
   * have a `characterId` but no `characterName` (pre-enrichment, pre-snapshot
   * rehearsals) get their name from the `Character` entity. Reliable because
   * `characterId` was always persisted on the event column.
   *
   * Full precedence for characterName: event → snapshot → Character lookup →
   * null. Text has no equivalent durable source for old rehearsals, so it
   * stays null (honest) rather than replaying a now-mutable scene.
   */
  private async resolveMissingCharacterNames(
    perLine: Map<number, PerLineAgg>,
  ): Promise<void> {
    const idsNeeding = new Set<string>();
    for (const entry of perLine.values()) {
      if (entry.characterName === null && entry.characterId) {
        idsNeeding.add(entry.characterId);
      }
    }
    if (idsNeeding.size === 0) return;

    const characters = await this.dataSource
      .getRepository(Character)
      .find({ where: { id: In([...idsNeeding]) } });
    if (characters.length === 0) return;

    const nameById = new Map(characters.map((c) => [c.id, c.name]));
    for (const entry of perLine.values()) {
      if (entry.characterName === null && entry.characterId) {
        const name = nameById.get(entry.characterId);
        if (name) entry.characterName = name;
      }
    }
  }

  private computeAnalyticsSummary(
    rehearsal: Rehersal,
    events: RehearsalEvent[],
  ): RehearsalAnalyticsSummary {
    const agg = this.aggregateEvents(events);
    const lifecycleMilestones = this.buildLifecycleMilestones(
      rehearsal,
      events,
    );

    // actor lines = union of started, completed, and any line with retries.
    // (LINE_RETRIED is dead; CUE_NO_MATCH replaces "retry" semantics. Any
    // line that produced a no-match also counts toward total actor lines.)
    const actorLineIndices = new Set<number>([
      ...agg.startedLineIndices,
      ...agg.completedLineIndices,
    ]);
    for (const [lineIndex, entry] of agg.perLine.entries()) {
      if (entry.noMatchAttempts > 0) actorLineIndices.add(lineIndex);
    }
    const totalActorLines = actorLineIndices.size;

    // P5: linesWithRetries now means "lines that had ≥1 CUE_NO_MATCH event".
    // linesCompletedFirstAttempt = completed lines whose noMatchAttempts == 0.
    const attemptCountPerLine: Array<{ lineIndex: number; attempts: number }> =
      [];
    let linesWithRetries = 0;
    for (const [lineIndex, entry] of agg.perLine.entries()) {
      if (entry.noMatchAttempts > 0) {
        linesWithRetries += 1;
        attemptCountPerLine.push({
          lineIndex,
          attempts: entry.noMatchAttempts,
        });
      }
    }
    attemptCountPerLine.sort((a, b) => a.lineIndex - b.lineIndex);

    const linesCompletedFirstAttempt = [...agg.completedLineIndices].filter(
      (idx) => (agg.perLine.get(idx)?.noMatchAttempts ?? 0) === 0,
    ).length;

    // response times from LINE_COMPLETED.data.responseTimeMs (gathered into
    // perLine by the aggregator)
    const responseTimes: number[] = [];
    for (const entry of agg.perLine.values()) {
      for (const rt of entry.responseTimes) responseTimes.push(rt);
    }
    const avgResponseTimeMs =
      responseTimes.length > 0
        ? Math.round(
            responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
          )
        : null;
    const slowestResponseTimeMs =
      responseTimes.length > 0 ? Math.max(...responseTimes) : null;
    const fastestResponseTimeMs =
      responseTimes.length > 0 ? Math.min(...responseTimes) : null;

    // session duration
    const sessionDurationMs =
      rehearsal.startedAt && rehearsal.endedAt
        ? rehearsal.endedAt.getTime() - rehearsal.startedAt.getTime()
        : rehearsal.sessionDurationSeconds
          ? rehearsal.sessionDurationSeconds * 1000
          : null;

    // paused duration from paired PAUSE/RESUME events (already sorted)
    let pausedDurationMs = 0;
    const pairCount = Math.min(agg.pauseTs.length, agg.resumeTs.length);
    for (let i = 0; i < pairCount; i++) {
      const gap = agg.resumeTs[i] - agg.pauseTs[i];
      if (gap > 0) pausedDurationMs += gap;
    }

    const activeDurationMs =
      sessionDurationMs !== null
        ? Math.max(0, sessionDurationMs - pausedDurationMs)
        : null;

    const supportsLineAnalytics = totalActorLines > 0;
    const completionPct = supportsLineAnalytics
      ? Math.round((agg.completedLineIndices.size / totalActorLines) * 100)
      : 0;

    // Detection quality: match-ratio aggregates from CUE_TRIGGERED samples.
    const avgMatchRatio =
      agg.matchRatioSamples.length > 0
        ? agg.matchRatioSamples.reduce((a, b) => a + b, 0) /
          agg.matchRatioSamples.length
        : null;
    const matchRatioP50 = this.percentile(agg.matchRatioSamples, 0.5);
    const matchRatioP90 = this.percentile(agg.matchRatioSamples, 0.9);

    // Per-line counters for stuck/drift/quiet-reset are derived by counting
    // lines whose perLine entry has count > 0.
    let linesStuck = 0;
    let linesDriftReset = 0;
    let linesQuietReset = 0;
    for (const entry of agg.perLine.values()) {
      if (entry.stuckCount > 0) linesStuck += 1;
      if (entry.driftResetCount > 0) linesDriftReset += 1;
      if (entry.quietResetCount > 0) linesQuietReset += 1;
    }

    // byMode breakdown — emit only modes the actor used.
    const byMode: Partial<
      Record<RehearsalDetectionMode, RehearsalAnalyticsByMode>
    > = {};
    for (const [mode, m] of agg.byMode.entries()) {
      const modeAvg =
        m.matchRatios.length > 0
          ? m.matchRatios.reduce((a, b) => a + b, 0) / m.matchRatios.length
          : null;
      byMode[mode] = {
        totalLines: m.lineIndices.size,
        linesAdvanced: m.advancedLineIndices.size,
        linesStuck: m.stuckLineIndices.size,
        linesDriftReset: m.driftLineIndices.size,
        avgMatchRatio: modeAvg !== null ? roundTo(modeAvg, 3) : null,
        triggerTypeBreakdown: { ...m.triggerTypes },
      };
    }

    return {
      schemaVersion: REHEARSAL_ANALYTICS_SCHEMA_VERSION,
      rehearsalId: rehearsal.id,
      computedAt: new Date().toISOString(),
      mode: rehearsal.mode,
      runtimeEngine: rehearsal.runtimeEngine,
      supportsLineAnalytics,
      totalActorLines,
      linesCompletedFirstAttempt,
      linesWithRetries,
      retriesPerLine: attemptCountPerLine.map(({ lineIndex, attempts }) => ({
        lineIndex,
        retryCount: attempts,
      })),
      avgResponseTimeMs,
      slowestResponseTimeMs,
      fastestResponseTimeMs,
      sessionDurationMs,
      activeDurationMs,
      pausedDurationMs,
      linesSkipped: agg.skippedLineIndices.size,
      completionPct,
      lifecycleMilestones,
      attemptCountPerLine,
      linesStuck,
      linesDriftReset,
      linesQuietReset,
      linesSkippedAfterStuck: agg.linesSkippedAfterStuck,
      staleFinalDropCount: agg.staleFinalDropCount,
      avgMatchRatio: avgMatchRatio !== null ? roundTo(avgMatchRatio, 3) : null,
      matchRatioP50: matchRatioP50 !== null ? roundTo(matchRatioP50, 3) : null,
      matchRatioP90: matchRatioP90 !== null ? roundTo(matchRatioP90, 3) : null,
      triggerTypeBreakdown: { ...agg.triggerTypeCounts },
      byMode,
    };
  }

  private percentile(samples: number[], p: number): number | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(p * sorted.length)),
    );
    return sorted[idx];
  }

  // difficult lines
  async getDifficultLines(rehearsalId: string, userId: string): Promise<any> {
    const rehearsal = await this.loadAndValidateRehearsal(rehearsalId, userId);
    const events = await this.loadEvents(rehearsal.id);
    const agg = this.aggregateEvents(events);
    this.applySnapshotFallback(agg.perLine, rehearsal);
    await this.resolveMissingCharacterNames(agg.perLine);

    const difficultLines: DifficultLine[] = [];
    for (const [lineIndex, entry] of agg.perLine.entries()) {
      const hasSignal =
        entry.noMatchAttempts > 0 ||
        entry.stuckCount > 0 ||
        entry.driftResetCount > 0 ||
        entry.quietResetCount > 0 ||
        entry.responseTimes.length > 0;
      if (!hasSignal) continue;

      const avgResponseTimeMs =
        entry.responseTimes.length > 0
          ? entry.responseTimes.reduce((a, b) => a + b, 0) /
            entry.responseTimes.length
          : 0;

      // P5 difficulty score: weighted sum of distinct struggle signals.
      // drift > stuck > no-match > quiet-reset in severity. Response-time
      // tiebreaker keeps slow-but-clean lines from outranking truly hard ones.
      const score =
        entry.noMatchAttempts * 2 +
        entry.stuckCount * 3 +
        entry.driftResetCount * 4 +
        entry.quietResetCount * 1 +
        avgResponseTimeMs / 1000;

      difficultLines.push({
        lineIndex,
        text: entry.lineText,
        characterName: entry.characterName,
        characterId: entry.characterId,
        score: roundTo(score, 2),
        // Legacy field retained for FE compat — now mirrors noMatchAttempts.
        retryCount: entry.noMatchAttempts,
        avgResponseTimeMs: Math.round(avgResponseTimeMs),
        // PII cap: keep the most recent attempts, truncate each.
        transcriptAttempts: entry.noMatchTranscripts
          .slice(-MAX_TRANSCRIPT_ATTEMPTS)
          .map((t) =>
            t.length > MAX_TRANSCRIPT_LENGTH
              ? t.slice(0, MAX_TRANSCRIPT_LENGTH)
              : t,
          ),
        noMatchAttempts: entry.noMatchAttempts,
        stuckCount: entry.stuckCount,
        driftResetCount: entry.driftResetCount,
        quietResetCount: entry.quietResetCount,
        textResolved: entry.lineText !== null,
        characterResolved:
          entry.characterId !== null || entry.characterName !== null,
      });
    }

    difficultLines.sort((a, b) => b.score - a.score);

    // Observability: track how much line identity we could resolve. Lets us
    // watch backfill coverage trend up as enriched/snapshotted sessions
    // replace pre-fix ones.
    const textResolvedCount = difficultLines.filter(
      (l) => l.textResolved,
    ).length;
    const charResolvedCount = difficultLines.filter(
      (l) => l.characterResolved,
    ).length;
    this.logger.debug(
      `[difficult-lines] rehearsal=${rehearsalId} lines=${difficultLines.length} ` +
        `textResolved=${textResolvedCount} charResolved=${charResolvedCount}`,
    );

    return {
      success: true,
      message: 'Difficult lines retrieved successfully',
      data: difficultLines.slice(0, 10),
    };
  }

  // rehearsal timeline
  async getTimeline(rehearsalId: string, userId: string): Promise<any> {
    const rehearsal = await this.loadAndValidateRehearsal(rehearsalId, userId);
    const events = await this.loadEvents(rehearsal.id);

    const origin = rehearsal.startedAt
      ? rehearsal.startedAt.getTime()
      : events.length > 0
        ? new Date(events[0].timestamp).getTime()
        : Date.now();

    const timeline = events.map((e) => ({
      eventType: e.eventType,
      lineIndex: e.lineIndex,
      characterId: e.characterId,
      timestamp: new Date(e.timestamp).toISOString(),
      offsetMs: new Date(e.timestamp).getTime() - origin,
      data: e.data,
    }));

    return {
      success: true,
      message: 'Rehearsal timeline retrieved successfully',
      data: timeline,
    };
  }

  // project progress
  async getProjectProgress(projectId: string, userId: string): Promise<any> {
    const project = await this.loadAndValidateProject(projectId, userId);

    // serve from cache if fresh
    const cached = project.metaData?.progress as ProjectProgress | undefined;
    const computedAt: string | undefined = project.metaData?.progressComputedAt;
    if (
      cached &&
      computedAt &&
      Date.now() - new Date(computedAt).getTime() < ONE_HOUR_MS &&
      (cached.schemaVersion ?? 0) === PROJECT_PROGRESS_SCHEMA_VERSION
    ) {
      return {
        success: true,
        message: 'Project progress retrieved successfully',
        data: cached,
      };
    }

    const progress = await this.computeAndCacheProjectProgress(project, userId);
    return {
      success: true,
      message: 'Project progress retrieved successfully',
      data: progress,
    };
  }

  async computeAndCacheProjectProgress(
    project: Project,
    userId: string,
  ): Promise<ProjectProgress> {
    const rehearsals = await this.dataSource.getRepository(Rehersal).find({
      where: {
        projectId: project.id,
        userId,
        status: RehearsalStatus.COMPLETED,
      },
      order: { startedAt: 'ASC' },
    });

    const progress = await this.buildProjectProgress(project.id, rehearsals);

    await this.dataSource
      .getRepository(Project)
      .createQueryBuilder()
      .update()
      .set({
        metaData: () =>
          `COALESCE("metaData", '{}') || '${JSON.stringify({ progressComputedAt: progress.computedAt, progress })}'::jsonb`,
      })
      .where('id = :id', { id: project.id })
      .execute();

    return progress;
  }

  private async buildProjectProgress(
    projectId: string,
    rehearsals: Rehersal[],
  ): Promise<ProjectProgress> {
    if (rehearsals.length === 0) {
      return {
        schemaVersion: PROJECT_PROGRESS_SCHEMA_VERSION,
        projectId,
        computedAt: new Date().toISOString(),
        scenesPracticed: [],
        totalRehearsalTimeMs: 0,
        improvementTrend: [],
        charactersPracticed: [],
        lastRehearsalDatePerScene: {},
        currentStreakDays: 0,
        matchQualityTrend: [],
        stuckRateTrend: [],
        charactersDifficulty: [],
      };
    }

    const rehearsalIds = rehearsals.map((r) => r.id);
    const allEvents = await this.dataSource.getRepository(RehearsalEvent).find({
      where: { rehearsalId: In(rehearsalIds) },
      order: { timestamp: 'ASC' },
    });

    // group events by rehearsalId
    const eventsByRehearsal = new Map<string, RehearsalEvent[]>();
    for (const e of allEvents) {
      if (!eventsByRehearsal.has(e.rehearsalId))
        eventsByRehearsal.set(e.rehearsalId, []);
      eventsByRehearsal.get(e.rehearsalId)!.push(e);
    }

    const sceneAttempts = new Map<
      string,
      { count: number; lastDate: Date | null }
    >();
    const characterSet = new Set<string>();
    let totalRehearsalTimeMs = 0;
    const sceneSessionData = new Map<string, SceneImprovementSession[]>();
    const matchQualityTrend: MatchQualitySession[] = [];
    const stuckRateTrend: StuckRateSession[] = [];
    // characterName → { scoreSum, lineCount }
    const charDifficulty = new Map<
      string,
      { scoreSum: number; lineCount: number }
    >();

    for (const r of rehearsals) {
      const events = eventsByRehearsal.get(r.id) ?? [];
      const summary = this.computeAnalyticsSummary(r, events);
      const agg = this.aggregateEvents(events);
      // Resolve character names (snapshot, then Character lookup for historical
      // data) so charactersDifficulty buckets by real names, not "Unknown".
      this.applySnapshotFallback(agg.perLine, r);
      await this.resolveMissingCharacterNames(agg.perLine);

      if (!sceneAttempts.has(r.sceneId)) {
        sceneAttempts.set(r.sceneId, { count: 0, lastDate: null });
      }
      const s = sceneAttempts.get(r.sceneId)!;
      s.count++;
      if (r.startedAt && (!s.lastDate || r.startedAt > s.lastDate))
        s.lastDate = r.startedAt;

      if (r.characterId) characterSet.add(r.characterId);
      totalRehearsalTimeMs += summary.sessionDurationMs ?? 0;

      if (!sceneSessionData.has(r.sceneId)) sceneSessionData.set(r.sceneId, []);
      const isoDate = r.startedAt
        ? r.startedAt.toISOString()
        : r.createdAt.toISOString();
      sceneSessionData.get(r.sceneId)!.push({
        rehearsalId: r.id,
        date: isoDate,
        avgResponseTimeMs: summary.avgResponseTimeMs,
      });

      matchQualityTrend.push({
        rehearsalId: r.id,
        date: isoDate,
        avgMatchRatio: summary.avgMatchRatio,
      });

      stuckRateTrend.push({
        rehearsalId: r.id,
        date: isoDate,
        stuckRate:
          summary.totalActorLines > 0
            ? roundTo(summary.linesStuck / summary.totalActorLines, 3)
            : 0,
        totalActorLines: summary.totalActorLines,
        linesStuck: summary.linesStuck,
      });

      // per-character difficulty: sum the per-line scores from this rehearsal
      // (replays the difficult-lines scoring on the same aggregate). Lines
      // with no struggle signal contribute 0 and aren't counted in lineCount.
      for (const entry of agg.perLine.values()) {
        const charName = entry.characterName || 'Unknown';
        const avgRt =
          entry.responseTimes.length > 0
            ? entry.responseTimes.reduce((a, b) => a + b, 0) /
              entry.responseTimes.length
            : 0;
        const score =
          entry.noMatchAttempts * 2 +
          entry.stuckCount * 3 +
          entry.driftResetCount * 4 +
          entry.quietResetCount * 1 +
          avgRt / 1000;
        if (score <= 0) continue;
        const slot = charDifficulty.get(charName) ?? {
          scoreSum: 0,
          lineCount: 0,
        };
        slot.scoreSum += score;
        slot.lineCount += 1;
        charDifficulty.set(charName, slot);
      }
    }

    const scenesPracticed: SceneProgress[] = [...sceneAttempts.entries()].map(
      ([sceneId, { count, lastDate }]) => ({
        sceneId,
        attemptCount: count,
        lastRehearsalDate: lastDate ? lastDate.toISOString() : null,
      }),
    );

    const lastRehearsalDatePerScene: Record<string, string> = {};
    for (const [sceneId, { lastDate }] of sceneAttempts.entries()) {
      if (lastDate) lastRehearsalDatePerScene[sceneId] = lastDate.toISOString();
    }

    const improvementTrend: SceneImprovementTrend[] = [
      ...sceneSessionData.entries(),
    ].map(([sceneId, sessions]) => ({ sceneId, sessions }));

    const charactersDifficulty: CharacterDifficulty[] = [
      ...charDifficulty.entries(),
    ]
      .map(([characterName, { scoreSum, lineCount }]) => ({
        characterName,
        avgDifficultyScore: roundTo(scoreSum / lineCount, 2),
        totalDifficultLines: lineCount,
      }))
      .sort((a, b) => b.avgDifficultyScore - a.avgDifficultyScore);

    const rehearsalDates = rehearsals
      .map((r) => r.startedAt)
      .filter((d): d is Date => d !== null);
    const currentStreakDays = this.computeStreak(rehearsalDates);

    return {
      schemaVersion: PROJECT_PROGRESS_SCHEMA_VERSION,
      projectId,
      computedAt: new Date().toISOString(),
      scenesPracticed,
      totalRehearsalTimeMs,
      improvementTrend,
      charactersPracticed: [...characterSet],
      lastRehearsalDatePerScene,
      currentStreakDays,
      matchQualityTrend,
      stuckRateTrend,
      charactersDifficulty,
    };
  }

  // scene comparison
  async getSceneComparison(projectId: string, userId: string): Promise<any> {
    await this.loadAndValidateProject(projectId, userId);

    const rehearsals = await this.dataSource.getRepository(Rehersal).find({
      where: { projectId, userId, status: RehearsalStatus.COMPLETED },
      order: { startedAt: 'ASC' },
    });

    // only scenes with >1 rehearsal
    const sceneCount = new Map<string, number>();
    for (const r of rehearsals) {
      sceneCount.set(r.sceneId, (sceneCount.get(r.sceneId) ?? 0) + 1);
    }
    const multiSceneIds = new Set(
      [...sceneCount.entries()].filter(([, c]) => c > 1).map(([id]) => id),
    );

    if (multiSceneIds.size === 0) return [];

    const multiRehearsal = rehearsals.filter((r) =>
      multiSceneIds.has(r.sceneId),
    );
    const rehearsalIds = multiRehearsal.map((r) => r.id);
    const allEvents = await this.dataSource.getRepository(RehearsalEvent).find({
      where: { rehearsalId: In(rehearsalIds) },
    });

    const eventsByRehearsal = new Map<string, RehearsalEvent[]>();
    for (const e of allEvents) {
      if (!eventsByRehearsal.has(e.rehearsalId))
        eventsByRehearsal.set(e.rehearsalId, []);
      eventsByRehearsal.get(e.rehearsalId)!.push(e);
    }

    const sceneResults = new Map<string, SceneComparisonSession[]>();
    for (const r of multiRehearsal) {
      const events = eventsByRehearsal.get(r.id) ?? [];
      const summary = this.computeAnalyticsSummary(r, events);

      const totalLines = summary.totalActorLines;
      const linesWithRetries = summary.linesWithRetries;
      const retryRate =
        totalLines > 0
          ? Math.round((linesWithRetries / totalLines) * 100) / 100
          : 0;

      if (!sceneResults.has(r.sceneId)) sceneResults.set(r.sceneId, []);
      sceneResults.get(r.sceneId)!.push({
        rehearsalId: r.id,
        date: r.startedAt
          ? r.startedAt.toISOString()
          : r.createdAt.toISOString(),
        avgResponseTimeMs: summary.avgResponseTimeMs,
        retryRate,
        completionPct: summary.completionPct,
      });
    }

    const comparison = [...sceneResults.entries()].map(
      ([sceneId, sessions]) => ({
        sceneId,
        sessions,
      }),
    );

    return {
      success: true,
      message: 'Scene comparison retrieved successfully',
      data: comparison,
    };
  }

  // batch computation (used by cron)
  async computeAnalyticsForRehearsalsSince(since: Date): Promise<void> {
    const rehearsals = await this.dataSource.getRepository(Rehersal).find({
      where: { status: RehearsalStatus.COMPLETED },
    });

    const recent = rehearsals.filter((r) => r.endedAt && r.endedAt >= since);

    for (const r of recent) {
      try {
        await this.computeAndCacheRehearsalAnalytics(r);
      } catch (err) {
        this.logger.warn(
          `Analytics cron failed for rehearsal ${r.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async computeProjectProgressForRehearsalsSince(since: Date): Promise<void> {
    const rehearsals = await this.dataSource.getRepository(Rehersal).find({
      where: { status: RehearsalStatus.COMPLETED },
    });

    const recent = rehearsals.filter((r) => r.endedAt && r.endedAt >= since);
    const projectUserPairs = new Map<string, string>();
    for (const r of recent) {
      if (!r.projectId) continue;
      if (!projectUserPairs.has(r.projectId))
        projectUserPairs.set(r.projectId, r.userId);
    }

    for (const [projectId, userId] of projectUserPairs.entries()) {
      try {
        const project = await this.dataSource
          .getRepository(Project)
          .findOne({ where: { id: projectId } });
        if (!project) continue;
        await this.computeAndCacheProjectProgress(project, userId);
      } catch (err) {
        this.logger.warn(
          `Progress cron failed for project ${projectId}: ${(err as Error).message}`,
        );
      }
    }
  }

  async recomputeStaleRehearsalAnalytics(
    stalenessThresholdMs: number,
  ): Promise<void> {
    const rehearsals = await this.dataSource.getRepository(Rehersal).find({
      where: { status: RehearsalStatus.COMPLETED },
    });

    const stale = rehearsals.filter((r) => {
      const computedAt: string | undefined = r.metaData?.analyticsComputedAt;
      if (!computedAt) return true;
      const cached = r.metaData?.analytics as
        | RehearsalAnalyticsSummary
        | undefined;
      if ((cached?.schemaVersion ?? 0) !== REHEARSAL_ANALYTICS_SCHEMA_VERSION) {
        return true;
      }
      return Date.now() - new Date(computedAt).getTime() > stalenessThresholdMs;
    });

    for (const r of stale) {
      try {
        await this.computeAndCacheRehearsalAnalytics(r);
      } catch (err) {
        this.logger.warn(
          `Nightly analytics failed for rehearsal ${r.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Strip raw transcript text (`data.transcript` + `data.transcriptFragment`)
   * from RehearsalEvent rows older than the retention window. Keeps the
   * structural counts analytics needs (eventType, lineIndex, characterId,
   * matchRatio, …) while removing the PII payload. Idempotent — only touches
   * rows that still carry a transcript. Returns the number of rows redacted.
   */
  async redactExpiredTranscripts(
    retentionMs: number = TRANSCRIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - retentionMs);
    const result = await this.dataSource
      .getRepository(RehearsalEvent)
      .createQueryBuilder()
      .update()
      .set({
        data: () => `("data" - 'transcript' - 'transcriptFragment')`,
      })
      .where('timestamp < :cutoff', { cutoff })
      .andWhere(`"data" IS NOT NULL`)
      .andWhere(`jsonb_exists("data", 'transcript')`)
      .execute();

    const affected = result.affected ?? 0;
    if (affected > 0) {
      this.logger.log(
        `Redacted transcripts from ${affected} RehearsalEvent rows older than ${cutoff.toISOString()}`,
      );
    }
    return affected;
  }

  private async loadAndValidateRehearsal(
    rehearsalId: string,
    userId: string,
  ): Promise<Rehersal> {
    const rehearsal = await this.dataSource
      .getRepository(Rehersal)
      .findOne({ where: { id: rehearsalId } });
    if (!rehearsal)
      throw new NotFoundException(`Rehearsal ${rehearsalId} not found`);
    if (rehearsal.userId !== userId) throw new ForbiddenException();
    return rehearsal;
  }

  private async loadAndValidateProject(
    projectId: string,
    userId: string,
  ): Promise<Project> {
    const project = await this.dataSource
      .getRepository(Project)
      .findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    if (project.userId !== userId) throw new ForbiddenException();
    return project;
  }

  private async loadEvents(rehearsalId: string): Promise<RehearsalEvent[]> {
    return this.dataSource.getRepository(RehearsalEvent).find({
      where: { rehearsalId },
      order: { timestamp: 'ASC' },
    });
  }

  private buildLifecycleMilestones(
    rehearsal: Rehersal,
    events: RehearsalEvent[],
  ): RehearsalLifecycleMilestones {
    const lifecycleEvents = events.filter((event) =>
      LIFECYCLE_EVENT_TYPES.has(event.eventType),
    );
    const findIso = (eventType: RehearsalEventType): string | null => {
      const match = lifecycleEvents.find(
        (event) => event.eventType === eventType,
      );
      return match ? new Date(match.timestamp).toISOString() : null;
    };

    const startedAt =
      rehearsal.startedAt?.toISOString() ??
      findIso(RehearsalEventType.SESSION_STARTED);
    const completedAt =
      rehearsal.status === RehearsalStatus.COMPLETED
        ? (rehearsal.endedAt?.toISOString() ??
          findIso(RehearsalEventType.SESSION_COMPLETED))
        : findIso(RehearsalEventType.SESSION_COMPLETED);
    const failedAt =
      rehearsal.status === RehearsalStatus.FAILED
        ? (rehearsal.endedAt?.toISOString() ??
          findIso(RehearsalEventType.SESSION_FAILED))
        : findIso(RehearsalEventType.SESSION_FAILED);
    const cancelledAt =
      rehearsal.status === RehearsalStatus.CANCELLED
        ? (rehearsal.endedAt?.toISOString() ??
          findIso(RehearsalEventType.SESSION_CANCELLED))
        : findIso(RehearsalEventType.SESSION_CANCELLED);

    return {
      createdAt:
        findIso(RehearsalEventType.SESSION_CREATED) ??
        rehearsal.createdAt.toISOString(),
      preparingAt: findIso(RehearsalEventType.SESSION_PREPARING),
      readyAt: findIso(RehearsalEventType.SESSION_READY),
      startedAt,
      pausedAt: findIso(RehearsalEventType.PAUSE),
      resumedAt: findIso(RehearsalEventType.RESUME),
      completedAt,
      failedAt,
      cancelledAt,
    };
  }

  private computeStreak(rehearsalDates: Date[]): number {
    if (rehearsalDates.length === 0) return 0;
    const ONE_DAY_MS = 86_400_000;
    const startOfDay = (d: Date): number => {
      const dt = new Date(d);
      dt.setHours(0, 0, 0, 0);
      return dt.getTime();
    };
    const distinctDays = [...new Set(rehearsalDates.map(startOfDay))].sort(
      (a, b) => b - a,
    );
    const today = startOfDay(new Date());
    // streak only active if most recent day is today or yesterday
    if (distinctDays[0] < today - ONE_DAY_MS) return 0;
    let streak = 1;
    for (let i = 1; i < distinctDays.length; i++) {
      if (distinctDays[i - 1] - distinctDays[i] === ONE_DAY_MS) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }
}
