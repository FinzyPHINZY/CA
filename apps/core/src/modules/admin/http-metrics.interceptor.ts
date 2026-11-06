import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { HttpMetricsCollectorService } from './http-metrics-collector.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    private readonly httpMetricsCollector: HttpMetricsCollectorService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const startedAtMs = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.recordMetrics(request?.url, response?.statusCode, startedAtMs);
        },
        error: () => {
          const rawStatusCode =
            typeof response?.statusCode === 'number' && response.statusCode > 0
              ? response.statusCode
              : 500;
          const statusCode = Math.max(rawStatusCode, 500);
          this.recordMetrics(request?.url, statusCode, startedAtMs);
        },
      }),
    );
  }

  private recordMetrics(
    url: string | undefined,
    statusCode: number,
    startedAtMs: number,
  ): void {
    // Avoid polluting platform telemetry with docs/static endpoints.
    if (url?.startsWith('/docs')) {
      return;
    }

    const durationMs = Math.max(0, Date.now() - startedAtMs);
    this.httpMetricsCollector.recordRequest(new Date(), durationMs, statusCode);
  }
}
