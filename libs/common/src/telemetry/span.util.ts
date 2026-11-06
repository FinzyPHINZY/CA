import { trace, SpanStatusCode, Span, context } from '@opentelemetry/api';

const tracer = trace.getTracer('cueactor');

/**
 * Run an async function inside a named span. Attributes are attached
 * to the span, and errors automatically set the span status.
 *
 * @example
 * const result = await withSpan('script.parse.execute', { taskId }, async (span) => {
 *   span.setAttribute('parser', 'pdf_layout');
 *   return await route_and_parse(fileBytes, ext);
 * });
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Extract the current trace ID for inclusion in structured logs.
 * Returns null if no active span or tracing is disabled.
 */
export function currentTraceId(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  return ctx.traceId !== '00000000000000000000000000000000'
    ? ctx.traceId
    : null;
}

/**
 * Extract both traceId and spanId for structured log lines.
 */
export function currentTraceContext(): {
  traceId: string | null;
  spanId: string | null;
} {
  const span = trace.getActiveSpan();
  if (!span) return { traceId: null, spanId: null };
  const ctx = span.spanContext();
  if (ctx.traceId === '00000000000000000000000000000000') {
    return { traceId: null, spanId: null };
  }
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
