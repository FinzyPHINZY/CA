import { Injectable } from '@nestjs/common';

interface MinuteBucket {
  bucketStartMs: number;
  requestCount: number;
  errorCount: number;
  totalDurationMs: number;
}

const ONE_MINUTE_MS = 60 * 1000;
const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

@Injectable()
export class HttpMetricsCollectorService {
  private readonly buckets = new Map<number, MinuteBucket>();

  recordRequest(at: Date, durationMs: number, statusCode: number): void {
    const timestampMs = at.getTime();
    const bucketStartMs =
      Math.floor(timestampMs / ONE_MINUTE_MS) * ONE_MINUTE_MS;

    const existing = this.buckets.get(bucketStartMs);
    if (existing) {
      existing.requestCount += 1;
      existing.totalDurationMs += durationMs;
      if (statusCode >= 500) {
        existing.errorCount += 1;
      }
    } else {
      this.buckets.set(bucketStartMs, {
        bucketStartMs,
        requestCount: 1,
        errorCount: statusCode >= 500 ? 1 : 0,
        totalDurationMs: durationMs,
      });
    }

    this.pruneOldBuckets(timestampMs);
  }

  getMetricsWindow(
    from: Date,
    to: Date,
  ): {
    requestCount: number;
    errorCount: number;
    totalDurationMs: number;
  } {
    const fromMs = from.getTime();
    const toMs = to.getTime();

    let requestCount = 0;
    let errorCount = 0;
    let totalDurationMs = 0;

    for (const bucket of this.buckets.values()) {
      const bucketEndMs = bucket.bucketStartMs + ONE_MINUTE_MS - 1;
      if (bucketEndMs < fromMs || bucket.bucketStartMs > toMs) {
        continue;
      }
      requestCount += bucket.requestCount;
      errorCount += bucket.errorCount;
      totalDurationMs += bucket.totalDurationMs;
    }

    return { requestCount, errorCount, totalDurationMs };
  }

  private pruneOldBuckets(nowMs: number): void {
    const oldestAllowedMs = nowMs - RETENTION_MS;
    for (const [bucketStartMs] of this.buckets.entries()) {
      if (bucketStartMs < oldestAllowedMs) {
        this.buckets.delete(bucketStartMs);
      }
    }
  }
}
