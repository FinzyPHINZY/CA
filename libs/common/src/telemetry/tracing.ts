/**
 * OpenTelemetry SDK bootstrap — must be imported BEFORE NestJS/Express.
 *
 * Usage in each service's main.ts:
 *   import './../../libs/common/src/telemetry/tracing';
 * or via --require flag in production.
 *
 * Env vars:
 *   OTEL_ENABLED           — set to "true" to activate (default: false)
 *   OTEL_SERVICE_NAME       — e.g. "core", "ai_service" (auto-detected from SERVICE_NAME)
 *   OTEL_EXPORTER_OTLP_ENDPOINT — e.g. "http://jaeger:4318" (default)
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

const enabled = process.env.OTEL_ENABLED === 'true';

if (enabled) {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

  const serviceName =
    process.env.OTEL_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    'cueactor-unknown';

  const traceExporter = new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4318/v1/traces',
  });

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Instrument HTTP, Express, ioredis, pg, amqplib (RabbitMQ) automatically
        '@opentelemetry/instrumentation-fs': { enabled: false }, // noisy
        '@opentelemetry/instrumentation-dns': { enabled: false }, // noisy
      }),
    ],
  });

  sdk.start();

  // Graceful shutdown
  const shutdown = () => {
    sdk
      .shutdown()
      .then(() => console.log('OpenTelemetry SDK shut down'))
      .catch((err) => console.error('OpenTelemetry shutdown error', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[OpenTelemetry] Tracing enabled for service "${serviceName}"`);
}

export { enabled as otelEnabled };
