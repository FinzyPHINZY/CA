import { ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { HttpMetricsCollectorService } from './http-metrics-collector.service';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

describe('HttpMetricsInterceptor + Collector', () => {
  let collector: HttpMetricsCollectorService;
  let interceptor: HttpMetricsInterceptor;

  beforeEach(() => {
    collector = new HttpMetricsCollectorService();
    interceptor = new HttpMetricsInterceptor(collector);
  });

  function makeContext(url: string, statusCode = 200): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ url }),
        getResponse: () => ({ statusCode }),
      }),
    } as any;
  }

  it('records successful request latency and keeps error count zero', (done) => {
    const ctx = makeContext('/api/admin/metrics/platform', 200);
    const next = { handle: () => of({ ok: true }) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => {
        const now = new Date();
        const start = new Date(now.getTime() - 60_000);
        const snapshot = collector.getMetricsWindow(start, now);
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.errorCount).toBe(0);
        expect(snapshot.totalDurationMs).toBeGreaterThanOrEqual(0);
        done();
      },
      error: done,
    });
  });

  it('records 5xx errors when handler throws', (done) => {
    const ctx = makeContext('/api/admin/metrics/platform', 500);
    const next = { handle: () => throwError(() => new Error('boom')) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => done(new Error('expected stream to error')),
      error: () => {
        const now = new Date();
        const start = new Date(now.getTime() - 60_000);
        const snapshot = collector.getMetricsWindow(start, now);
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.errorCount).toBe(1);
        done();
      },
    });
  });

  it('treats thrown request as 5xx even when response status is still 200', (done) => {
    const ctx = makeContext('/api/admin/metrics/platform', 200);
    const next = { handle: () => throwError(() => new Error('boom')) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => done(new Error('expected stream to error')),
      error: () => {
        const now = new Date();
        const start = new Date(now.getTime() - 60_000);
        const snapshot = collector.getMetricsWindow(start, now);
        expect(snapshot.requestCount).toBe(1);
        expect(snapshot.errorCount).toBe(1);
        done();
      },
    });
  });

  it('does not record swagger docs traffic', (done) => {
    const ctx = makeContext('/docs', 200);
    const next = { handle: () => of({ ok: true }) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => {
        const now = new Date();
        const start = new Date(now.getTime() - 60_000);
        const snapshot = collector.getMetricsWindow(start, now);
        expect(snapshot.requestCount).toBe(0);
        done();
      },
      error: done,
    });
  });

  it('includes bucket when window overlaps part of a minute', () => {
    const base = new Date('2026-05-06T10:05:10.000Z');
    collector.recordRequest(base, 250, 200);

    const from = new Date('2026-05-06T10:05:30.000Z');
    const to = new Date('2026-05-06T10:05:59.999Z');
    const snapshot = collector.getMetricsWindow(from, to);

    expect(snapshot.requestCount).toBe(1);
    expect(snapshot.errorCount).toBe(0);
  });
});
