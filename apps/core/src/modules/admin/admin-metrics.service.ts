import { Project, UsageRecord, UsageService, User } from '@app/common';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminMetricsQueryDto } from './dto/admin-metrics-query.dto';
import { PlatformMetricsDto } from './dto/platform-metrics.dto';
import { ExtendedUsageMetricsDto } from './dto/extended-usage-metrics.dto';
import { TokenMetricsDto } from './dto/token-metrics.dto';
import { UserMetricsDto } from './dto/user-metrics.dto';
import { HttpMetricsCollectorService } from './http-metrics-collector.service';
import {
  ADMIN_PROJECT_ALIAS,
  ADMIN_USAGE_RECORD_ALIAS,
  ADMIN_USER_ALIAS,
  ADMIN_USER_ROLE_ALIAS,
} from './admin-query-aliases';

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const USER_ROLES = ['actor', 'reader'];

const ENV_GEMINI_USD_PER_MTOK = 'ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS';
const ENV_ELEVEN_USD_PER_MCHAR =
  'ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS';
const ENV_DEEPGRAM_USD_PER_MIN = 'ADMIN_METRICS_DEEPGRAM_USD_PER_MINUTE';
const ENV_AGORA_USD_PER_MIN = 'ADMIN_METRICS_AGORA_USD_PER_MINUTE';

function readOptionalUsdPerUnit(envKey: string): number | null {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

function readOptionalUsdPerMillion(envKey: string): number | null {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') {
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

function parseAggregateQtyCount(
  row: {
    quantitySum: string | null;
    rowCount: string | null;
  } | null,
): { quantitySum: number; rowCount: number } {
  const quantitySum = Number(row?.quantitySum ?? 0);
  const rowCount = Number(row?.rowCount ?? 0);
  return {
    quantitySum: Number.isFinite(quantitySum) ? quantitySum : 0,
    rowCount: Number.isFinite(rowCount) ? rowCount : 0,
  };
}

function roundUsd(n: number): number {
  return Number(n.toFixed(4));
}

function costFromQtyPerMillion(
  qty: number,
  ratePerMillion: number | null,
): number | null {
  if (ratePerMillion == null) {
    return null;
  }
  return roundUsd((qty / 1_000_000) * ratePerMillion);
}

function usdDelta(
  current: number | null,
  previous: number | null,
): number | null {
  if (current == null || previous == null) {
    return null;
  }
  return roundUsd(current - previous);
}

function totalUsdParts(
  gemini: number | null,
  eleven: number | null,
): number | null {
  if (gemini == null && eleven == null) {
    return null;
  }
  return roundUsd((gemini ?? 0) + (eleven ?? 0));
}

type UsageMetricsAggRow = {
  geminiCurSum: string | null;
  geminiCurCnt: string | null;
  geminiPrevSum: string | null;
  geminiPrevCnt: string | null;
  elevenCurSum: string | null;
  elevenCurCnt: string | null;
  elevenPrevSum: string | null;
  elevenPrevCnt: string | null;
};

function splitUsageMetricsAggRow(row: UsageMetricsAggRow | null | undefined): {
  geminiCurrent: { quantitySum: number; rowCount: number };
  geminiPrevious: { quantitySum: number; rowCount: number };
  elevenCurrent: { quantitySum: number; rowCount: number };
  elevenPrevious: { quantitySum: number; rowCount: number };
} {
  if (!row) {
    const z = { quantitySum: 0, rowCount: 0 };
    return {
      geminiCurrent: z,
      geminiPrevious: z,
      elevenCurrent: z,
      elevenPrevious: z,
    };
  }
  return {
    geminiCurrent: parseAggregateQtyCount({
      quantitySum: row.geminiCurSum,
      rowCount: row.geminiCurCnt,
    }),
    geminiPrevious: parseAggregateQtyCount({
      quantitySum: row.geminiPrevSum,
      rowCount: row.geminiPrevCnt,
    }),
    elevenCurrent: parseAggregateQtyCount({
      quantitySum: row.elevenCurSum,
      rowCount: row.elevenCurCnt,
    }),
    elevenPrevious: parseAggregateQtyCount({
      quantitySum: row.elevenPrevSum,
      rowCount: row.elevenPrevCnt,
    }),
  };
}

@Injectable()
export class AdminMetricsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly httpMetricsCollector: HttpMetricsCollectorService,
  ) {}

  async getUserMetrics(query: AdminMetricsQueryDto): Promise<UserMetricsDto> {
    const { from, to } = this.resolveWindow(query);
    const { totalSignups, activeUsers } = await this.aggregateUserMetricsWindow(
      from,
      to,
    );

    return {
      totalSignups,
      activeUsers,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  async getPlatformMetrics(
    query: AdminMetricsQueryDto,
  ): Promise<PlatformMetricsDto> {
    const { from, to } = this.resolveWindow(query);

    const p = ADMIN_PROJECT_ALIAS;
    const projectsCreated = await this.dataSource
      .getRepository(Project)
      .createQueryBuilder(p)
      .where(`${p}."deletedAt" IS NULL`)
      .andWhere(`${p}."createdAt" BETWEEN :winFrom AND :winTo`, {
        winFrom: from,
        winTo: to,
      })
      .getCount();

    const windowMs = Math.max(1, to.getTime() - from.getTime());
    const runningMs = Math.max(0, Math.floor(process.uptime() * 1000));
    const coveredMs = Math.min(runningMs, windowMs);
    const uptimePercentage = Number(((coveredMs / windowMs) * 100).toFixed(2));
    const httpWindowMetrics = this.httpMetricsCollector.getMetricsWindow(
      from,
      to,
    );
    const avgLatencySeconds =
      httpWindowMetrics.requestCount > 0
        ? Number(
            (
              httpWindowMetrics.totalDurationMs /
              httpWindowMetrics.requestCount /
              1000
            ).toFixed(3),
          )
        : null;
    const errorRatePercentage =
      httpWindowMetrics.requestCount > 0
        ? Number(
            (
              (httpWindowMetrics.errorCount / httpWindowMetrics.requestCount) *
              100
            ).toFixed(2),
          )
        : null;

    return {
      projectsCreated,
      uptimePercentage,
      avgLatencySeconds,
      errorRatePercentage,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  async getExtendedUsageMetrics(
    query: AdminMetricsQueryDto,
  ): Promise<ExtendedUsageMetricsDto> {
    const { from, to } = this.resolveWindow(query);
    const { previousFrom, previousTo } = this.previousWindow(from, to);

    const deepgramRate = readOptionalUsdPerUnit(ENV_DEEPGRAM_USD_PER_MIN);
    const agoraRate = readOptionalUsdPerUnit(ENV_AGORA_USD_PER_MIN);

    const { deepgramCurrent, deepgramPrevious, agoraCurrent, agoraPrevious, s3Current, s3Previous } =
      await this.aggregateExtendedUsageAcrossWindows(
        from,
        to,
        previousFrom,
        previousTo,
      );

    const deepgramMinutesTotal = deepgramCurrent.quantitySum;
    const agoraMinutesTotal = agoraCurrent.quantitySum;
    const s3StorageBytesTotal = s3Current.quantitySum;

    return {
      deepgramMinutesTotal,
      deepgramUsageRecordCount: deepgramCurrent.rowCount,
      agoraMinutesTotal,
      agoraUsageRecordCount: agoraCurrent.rowCount,
      s3StorageBytesTotal,
      s3StorageUsageRecordCount: s3Current.rowCount,
      deepgramMinutesPreviousTotal: deepgramPrevious.quantitySum,
      deepgramMinutesDelta:
        deepgramMinutesTotal - deepgramPrevious.quantitySum,
      agoraMinutesPreviousTotal: agoraPrevious.quantitySum,
      agoraMinutesDelta: agoraMinutesTotal - agoraPrevious.quantitySum,
      s3StorageBytesPreviousTotal: s3Previous.quantitySum,
      s3StorageBytesDelta: s3StorageBytesTotal - s3Previous.quantitySum,
      deepgramEstimatedCostUsd: deepgramRate
        ? roundUsd(deepgramMinutesTotal * deepgramRate)
        : null,
      agoraEstimatedCostUsd: agoraRate
        ? roundUsd(agoraMinutesTotal * agoraRate)
        : null,
      from: from.toISOString(),
      to: to.toISOString(),
      previousFrom: previousFrom.toISOString(),
      previousTo: previousTo.toISOString(),
    };
  }

  async getTokenMetrics(query: AdminMetricsQueryDto): Promise<TokenMetricsDto> {
    const { from, to } = this.resolveWindow(query);
    const { previousFrom, previousTo } = this.previousWindow(from, to);

    const geminiRate = readOptionalUsdPerMillion(ENV_GEMINI_USD_PER_MTOK);
    const elevenRate = readOptionalUsdPerMillion(ENV_ELEVEN_USD_PER_MCHAR);

    const { geminiCurrent, geminiPrevious, elevenCurrent, elevenPrevious } =
      await this.aggregateTokenUsageAcrossWindows(
        from,
        to,
        previousFrom,
        previousTo,
      );

    const geminiTokenTotal = geminiCurrent.quantitySum;
    const geminiUsageRecordCount = geminiCurrent.rowCount;
    const geminiTokenPreviousTotal = geminiPrevious.quantitySum;
    const geminiUsageRecordCountPrevious = geminiPrevious.rowCount;

    const elevenLabsCharacterTotal = elevenCurrent.quantitySum;
    const elevenLabsUsageRecordCount = elevenCurrent.rowCount;
    const elevenLabsCharacterPreviousTotal = elevenPrevious.quantitySum;
    const elevenLabsUsageRecordCountPrevious = elevenPrevious.rowCount;

    const geminiEstimatedCostUsd = costFromQtyPerMillion(
      geminiTokenTotal,
      geminiRate,
    );
    const geminiEstimatedCostPreviousUsd = costFromQtyPerMillion(
      geminiTokenPreviousTotal,
      geminiRate,
    );
    const elevenLabsEstimatedCostUsd = costFromQtyPerMillion(
      elevenLabsCharacterTotal,
      elevenRate,
    );
    const elevenLabsEstimatedCostPreviousUsd = costFromQtyPerMillion(
      elevenLabsCharacterPreviousTotal,
      elevenRate,
    );

    const totalEstimatedCostUsd = totalUsdParts(
      geminiEstimatedCostUsd,
      elevenLabsEstimatedCostUsd,
    );
    const totalEstimatedCostPreviousUsd = totalUsdParts(
      geminiEstimatedCostPreviousUsd,
      elevenLabsEstimatedCostPreviousUsd,
    );

    return {
      geminiTokenTotal,
      geminiUsageRecordCount,
      elevenLabsCharacterTotal,
      elevenLabsUsageRecordCount,
      previousFrom: previousFrom.toISOString(),
      previousTo: previousTo.toISOString(),
      geminiTokenPreviousTotal,
      geminiTokenDelta: geminiTokenTotal - geminiTokenPreviousTotal,
      geminiUsageRecordCountPrevious,
      geminiUsageRecordCountDelta:
        geminiUsageRecordCount - geminiUsageRecordCountPrevious,
      elevenLabsCharacterPreviousTotal,
      elevenLabsCharacterDelta:
        elevenLabsCharacterTotal - elevenLabsCharacterPreviousTotal,
      elevenLabsUsageRecordCountPrevious,
      elevenLabsUsageRecordCountDelta:
        elevenLabsUsageRecordCount - elevenLabsUsageRecordCountPrevious,
      geminiEstimatedCostUsd,
      geminiEstimatedCostPreviousUsd,
      geminiEstimatedCostDeltaUsd: usdDelta(
        geminiEstimatedCostUsd,
        geminiEstimatedCostPreviousUsd,
      ),
      elevenLabsEstimatedCostUsd,
      elevenLabsEstimatedCostPreviousUsd,
      elevenLabsEstimatedCostDeltaUsd: usdDelta(
        elevenLabsEstimatedCostUsd,
        elevenLabsEstimatedCostPreviousUsd,
      ),
      totalEstimatedCostUsd,
      totalEstimatedCostPreviousUsd,
      totalEstimatedCostDeltaUsd: usdDelta(
        totalEstimatedCostUsd,
        totalEstimatedCostPreviousUsd,
      ),
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  /** One round-trip: actor/reader signups vs active logins for the same window (PostgreSQL FILTER). */
  private async aggregateUserMetricsWindow(
    from: Date,
    to: Date,
  ): Promise<{ totalSignups: number; activeUsers: number }> {
    const u = ADMIN_USER_ALIAS;
    const role = ADMIN_USER_ROLE_ALIAS;
    const row = await this.dataSource
      .getRepository(User)
      .createQueryBuilder(u)
      .leftJoin(`${u}.role`, role)
      .select(
        `COUNT(${u}.id) FILTER (WHERE ${u}."createdAt" BETWEEN :winFrom AND :winTo)`,
        'totalSignups',
      )
      .addSelect(
        `COUNT(${u}.id) FILTER (WHERE ${u}.disabled = false AND ${u}."deletedAt" IS NULL AND ${u}."lastLoginAt" IS NOT NULL AND ${u}."lastLoginAt" BETWEEN :winFrom AND :winTo)`,
        'activeUsers',
      )
      .where(`${role}.code IN (:...roles)`)
      .andWhere(
        `(${u}."createdAt" BETWEEN :winFrom AND :winTo OR (${u}.disabled = false AND ${u}."deletedAt" IS NULL AND ${u}."lastLoginAt" IS NOT NULL AND ${u}."lastLoginAt" BETWEEN :winFrom AND :winTo))`,
      )
      .setParameters({
        roles: USER_ROLES,
        winFrom: from,
        winTo: to,
      })
      .getRawOne<{ totalSignups: string | null; activeUsers: string | null }>();

    if (!row) {
      return { totalSignups: 0, activeUsers: 0 };
    }

    const totalSignups = Number(row.totalSignups ?? 0);
    const activeUsers = Number(row.activeUsers ?? 0);
    return {
      totalSignups: Number.isFinite(totalSignups) ? totalSignups : 0,
      activeUsers: Number.isFinite(activeUsers) ? activeUsers : 0,
    };
  }

  private previousWindow(
    from: Date,
    to: Date,
  ): { previousFrom: Date; previousTo: Date } {
    const spanMs = Math.max(0, to.getTime() - from.getTime());
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - spanMs);
    return { previousFrom, previousTo };
  }

  /** Single DB round-trip: PostgreSQL FILTER aggregates over both windows. */
  private async aggregateTokenUsageAcrossWindows(
    from: Date,
    to: Date,
    previousFrom: Date,
    previousTo: Date,
  ): Promise<{
    geminiCurrent: { quantitySum: number; rowCount: number };
    geminiPrevious: { quantitySum: number; rowCount: number };
    elevenCurrent: { quantitySum: number; rowCount: number };
    elevenPrevious: { quantitySum: number; rowCount: number };
  }> {
    const gemini = UsageService.GEMINI_TOKENS;
    const eleven = UsageService.ELEVENLABS_CHARACTERS;

    const ur = ADMIN_USAGE_RECORD_ALIAS;
    const row = await this.dataSource
      .getRepository(UsageRecord)
      .createQueryBuilder(ur)
      .select(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :gemini AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo), 0)`,
        'geminiCurSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :gemini AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo)`,
        'geminiCurCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :gemini AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo), 0)`,
        'geminiPrevSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :gemini AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
        'geminiPrevCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :eleven AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo), 0)`,
        'elevenCurSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :eleven AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo)`,
        'elevenCurCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :eleven AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo), 0)`,
        'elevenPrevSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :eleven AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
        'elevenPrevCnt',
      )
      .where(`${ur}."deletedAt" IS NULL`)
      .andWhere(`${ur}.service IN (:...usageSvc)`, {
        usageSvc: [gemini, eleven],
      })
      .andWhere(
        `(${ur}."createdAt" BETWEEN :winFrom AND :winTo OR ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
      )
      .setParameters({
        winFrom: from,
        winTo: to,
        prevFrom: previousFrom,
        prevTo: previousTo,
        gemini,
        eleven,
      })
      .getRawOne<UsageMetricsAggRow>();

    return splitUsageMetricsAggRow(row);
  }

  private async aggregateExtendedUsageAcrossWindows(
    from: Date,
    to: Date,
    previousFrom: Date,
    previousTo: Date,
  ) {
    const deepgram = UsageService.DEEPGRAM_MINUTES;
    const agora = UsageService.AGORA_MINUTES;
    const s3 = UsageService.S3_STORAGE_BYTES;
    const ur = ADMIN_USAGE_RECORD_ALIAS;

    const row = await this.dataSource
      .getRepository(UsageRecord)
      .createQueryBuilder(ur)
      .select(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :deepgram AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo), 0)`,
        'dgCurSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :deepgram AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo)`,
        'dgCurCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :deepgram AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo), 0)`,
        'dgPrevSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :deepgram AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
        'dgPrevCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :agora AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo), 0)`,
        'agCurSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :agora AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo)`,
        'agCurCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :agora AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo), 0)`,
        'agPrevSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :agora AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
        'agPrevCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :s3 AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo), 0)`,
        's3CurSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :s3 AND ${ur}."createdAt" BETWEEN :winFrom AND :winTo)`,
        's3CurCnt',
      )
      .addSelect(
        `COALESCE(SUM(${ur}.quantity) FILTER (WHERE ${ur}.service = :s3 AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo), 0)`,
        's3PrevSum',
      )
      .addSelect(
        `COUNT(${ur}.id) FILTER (WHERE ${ur}.service = :s3 AND ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
        's3PrevCnt',
      )
      .where(`${ur}."deletedAt" IS NULL`)
      .andWhere(`${ur}.service IN (:...usageSvc)`, {
        usageSvc: [deepgram, agora, s3],
      })
      .andWhere(
        `(${ur}."createdAt" BETWEEN :winFrom AND :winTo OR ${ur}."createdAt" BETWEEN :prevFrom AND :prevTo)`,
      )
      .setParameters({
        winFrom: from,
        winTo: to,
        prevFrom: previousFrom,
        prevTo: previousTo,
        deepgram,
        agora,
        s3,
      })
      .getRawOne<{
        dgCurSum: string | null;
        dgCurCnt: string | null;
        dgPrevSum: string | null;
        dgPrevCnt: string | null;
        agCurSum: string | null;
        agCurCnt: string | null;
        agPrevSum: string | null;
        agPrevCnt: string | null;
        s3CurSum: string | null;
        s3CurCnt: string | null;
        s3PrevSum: string | null;
        s3PrevCnt: string | null;
      }>();

    return {
      deepgramCurrent: parseAggregateQtyCount({
        quantitySum: row?.dgCurSum,
        rowCount: row?.dgCurCnt,
      }),
      deepgramPrevious: parseAggregateQtyCount({
        quantitySum: row?.dgPrevSum,
        rowCount: row?.dgPrevCnt,
      }),
      agoraCurrent: parseAggregateQtyCount({
        quantitySum: row?.agCurSum,
        rowCount: row?.agCurCnt,
      }),
      agoraPrevious: parseAggregateQtyCount({
        quantitySum: row?.agPrevSum,
        rowCount: row?.agPrevCnt,
      }),
      s3Current: parseAggregateQtyCount({
        quantitySum: row?.s3CurSum,
        rowCount: row?.s3CurCnt,
      }),
      s3Previous: parseAggregateQtyCount({
        quantitySum: row?.s3PrevSum,
        rowCount: row?.s3PrevCnt,
      }),
    };
  }

  private resolveWindow(query: AdminMetricsQueryDto): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_WINDOW_MS);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date filter value');
    }
    if (from > to) {
      throw new BadRequestException(
        '"from" must be earlier than or equal to "to"',
      );
    }

    return { from, to };
  }
}
