import { UsageRecord, UsageService, User } from '@app/common';
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminMetricsService } from './admin-metrics.service';
import { HttpMetricsCollectorService } from './http-metrics-collector.service';

describe('AdminMetricsService', () => {
  let service: AdminMetricsService;
  let dataSource: jest.Mocked<Pick<DataSource, 'getRepository'>>;
  let httpMetricsCollector: jest.Mocked<
    Pick<HttpMetricsCollectorService, 'getMetricsWindow'>
  >;

  let userRepoQb: any;
  let projectRepoQb: any;
  let usageRepoQb: any;
  let projectGetCountValue: number;

  const defaultUsageMetricsAggRow = () => ({
    geminiCurSum: '1500000',
    geminiCurCnt: '42',
    geminiPrevSum: '1000000',
    geminiPrevCnt: '30',
    elevenCurSum: '20000',
    elevenCurCnt: '5',
    elevenPrevSum: '15000',
    elevenPrevCnt: '4',
  });

  beforeEach(() => {
    projectGetCountValue = 121;

    usageRepoQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
    };

    userRepoQb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        totalSignups: '98',
        activeUsers: '190',
      }),
    };

    projectRepoQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockImplementation(async () => projectGetCountValue),
    };

    dataSource = {
      getRepository: jest.fn().mockImplementation((entity: any) => ({
        createQueryBuilder: jest
          .fn()
          .mockReturnValue(
            entity === UsageRecord || entity?.name === 'UsageRecord'
              ? usageRepoQb
              : entity === User || entity?.name === 'User'
                ? userRepoQb
                : entity?.name === 'Project'
                  ? projectRepoQb
                  : userRepoQb,
          ),
      })),
    };

    httpMetricsCollector = {
      getMetricsWindow: jest.fn().mockReturnValue({
        requestCount: 10,
        errorCount: 2,
        totalDurationMs: 5000,
      }),
    };

    service = new AdminMetricsService(
      dataSource as unknown as DataSource,
      httpMetricsCollector as unknown as HttpMetricsCollectorService,
    );

    usageRepoQb.getRawOne.mockResolvedValue(defaultUsageMetricsAggRow());
  });

  it('returns user metrics for explicit window', async () => {
    const result = await service.getUserMetrics({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-06T23:59:59.999Z',
    });

    expect(result.totalSignups).toBe(98);
    expect(result.activeUsers).toBe(190);
    expect(result.from).toBe('2026-05-01T00:00:00.000Z');
    expect(result.to).toBe('2026-05-06T23:59:59.999Z');
    expect(userRepoQb.getRawOne).toHaveBeenCalledTimes(1);
    expect(userRepoQb.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({
        winFrom: expect.any(Date),
        winTo: expect.any(Date),
        roles: ['actor', 'reader'],
      }),
    );
  });

  it('returns platform metrics with computed latency and error rate', async () => {
    const result = await service.getPlatformMetrics({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-06T23:59:59.999Z',
    });

    expect(result.projectsCreated).toBe(121);
    expect(result.avgLatencySeconds).toBe(0.5);
    expect(result.errorRatePercentage).toBe(20);
    expect(typeof result.uptimePercentage).toBe('number');
    expect(httpMetricsCollector.getMetricsWindow).toHaveBeenCalledTimes(1);
  });

  it('returns null latency and error rate when no requests exist in range', async () => {
    httpMetricsCollector.getMetricsWindow.mockReturnValueOnce({
      requestCount: 0,
      errorCount: 0,
      totalDurationMs: 0,
    });

    const result = await service.getPlatformMetrics({});

    expect(result.avgLatencySeconds).toBeNull();
    expect(result.errorRatePercentage).toBeNull();
  });

  it('throws when from is later than to', async () => {
    await expect(
      service.getUserMetrics({
        from: '2026-05-06T23:59:59.999Z',
        to: '2026-05-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns token metrics for explicit window', async () => {
    const from = new Date('2026-05-01T00:00:00.000Z');
    const to = new Date('2026-05-06T23:59:59.999Z');
    const spanMs = Math.max(0, to.getTime() - from.getTime());
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - spanMs);

    const result = await service.getTokenMetrics({
      from: from.toISOString(),
      to: to.toISOString(),
    });

    expect(result.geminiTokenTotal).toBe(1_500_000);
    expect(result.geminiUsageRecordCount).toBe(42);
    expect(result.elevenLabsCharacterTotal).toBe(20_000);
    expect(result.elevenLabsUsageRecordCount).toBe(5);
    expect(result.geminiTokenPreviousTotal).toBe(1_000_000);
    expect(result.geminiTokenDelta).toBe(500_000);
    expect(result.elevenLabsCharacterPreviousTotal).toBe(15_000);
    expect(result.elevenLabsCharacterDelta).toBe(5_000);
    expect(result.previousFrom).toBe(previousFrom.toISOString());
    expect(result.previousTo).toBe(previousTo.toISOString());
    expect(result.from).toBe('2026-05-01T00:00:00.000Z');
    expect(result.to).toBe('2026-05-06T23:59:59.999Z');
    expect(usageRepoQb.getRawOne).toHaveBeenCalledTimes(1);
    expect(usageRepoQb.where).toHaveBeenCalledWith('ur."deletedAt" IS NULL');
    expect(usageRepoQb.andWhere).toHaveBeenCalledWith(
      'ur.service IN (:...usageSvc)',
      {
        usageSvc: [
          UsageService.GEMINI_TOKENS,
          UsageService.ELEVENLABS_CHARACTERS,
        ],
      },
    );
    expect(usageRepoQb.andWhere).toHaveBeenCalledWith(
      '(ur."createdAt" BETWEEN :winFrom AND :winTo OR ur."createdAt" BETWEEN :prevFrom AND :prevTo)',
    );
  });

  it('getTokenMetrics throws when from is later than to', async () => {
    await expect(
      service.getTokenMetrics({
        from: '2026-05-06T23:59:59.999Z',
        to: '2026-05-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getTokenMetrics returns zeros when aggregate row is empty', async () => {
    usageRepoQb.getRawOne.mockResolvedValueOnce(null);

    const result = await service.getTokenMetrics({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-06T23:59:59.999Z',
    });

    expect(result.geminiTokenTotal).toBe(0);
    expect(result.geminiUsageRecordCount).toBe(0);
    expect(result.elevenLabsCharacterTotal).toBe(0);
    expect(result.geminiTokenDelta).toBe(0);
  });

  it('getTokenMetrics coerces PG string aggregates', async () => {
    usageRepoQb.getRawOne.mockResolvedValueOnce({
      geminiCurSum: '0',
      geminiCurCnt: '0',
      geminiPrevSum: '0',
      geminiPrevCnt: '0',
      elevenCurSum: '0',
      elevenCurCnt: '0',
      elevenPrevSum: '0',
      elevenPrevCnt: '0',
    });

    const result = await service.getTokenMetrics({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-06T23:59:59.999Z',
    });

    expect(result.geminiTokenTotal).toBe(0);
    expect(result.geminiUsageRecordCount).toBe(0);
  });

  it('getTokenMetrics resolves default window when query is empty', async () => {
    const result = await service.getTokenMetrics({});

    expect(result.geminiTokenTotal).toBe(1_500_000);
    expect(result.geminiUsageRecordCount).toBe(42);
    expect(typeof result.from).toBe('string');
    expect(typeof result.to).toBe('string');
    expect(new Date(result.from).getTime()).toBeLessThanOrEqual(
      new Date(result.to).getTime(),
    );
  });

  it('getTokenMetrics fills USD estimates when env rates are set', async () => {
    const prevGemini = process.env.ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS;
    const prevEleven =
      process.env.ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS;
    process.env.ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS = '10';
    process.env.ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS = '5';

    try {
      const result = await service.getTokenMetrics({
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-06T23:59:59.999Z',
      });

      expect(result.geminiEstimatedCostUsd).toBe(15);
      expect(result.geminiEstimatedCostPreviousUsd).toBe(10);
      expect(result.geminiEstimatedCostDeltaUsd).toBe(5);
      expect(result.elevenLabsEstimatedCostUsd).toBe(0.1);
      expect(result.elevenLabsEstimatedCostPreviousUsd).toBe(0.075);
      expect(result.elevenLabsEstimatedCostDeltaUsd).toBe(0.025);
      expect(result.totalEstimatedCostUsd).toBe(15.1);
      expect(result.totalEstimatedCostPreviousUsd).toBe(10.075);
      expect(result.totalEstimatedCostDeltaUsd).toBe(5.025);
    } finally {
      if (prevGemini === undefined) {
        delete process.env.ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS;
      } else {
        process.env.ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS = prevGemini;
      }
      if (prevEleven === undefined) {
        delete process.env.ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS;
      } else {
        process.env.ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS = prevEleven;
      }
    }
  });
});
