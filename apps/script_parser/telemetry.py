"""
OpenTelemetry bootstrap for the Python script_parser service.

Activated by OTEL_ENABLED=true. Instruments FastAPI, httpx, and aio-pika.
Exports traces via OTLP/HTTP to the configured collector (Jaeger by default).
"""
from __future__ import annotations

import os

_ENABLED = os.getenv("OTEL_ENABLED", "false").lower() == "true"


def init_tracing() -> None:
    if not _ENABLED:
        return

    try:
        from opentelemetry import trace
    except ImportError:
        print("[OpenTelemetry] OTEL_ENABLED=true but opentelemetry packages not installed — skipping")
        return
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION

    service_name = os.getenv("OTEL_SERVICE_NAME", os.getenv("SERVICE_NAME", "script_parser"))
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://jaeger:4318") + "/v1/traces"

    resource = Resource.create({
        SERVICE_NAME: service_name,
        SERVICE_VERSION: os.getenv("APP_VERSION", "0.0.0"),
    })

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    # Auto-instrument FastAPI
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument()
    except Exception:
        pass

    # Auto-instrument httpx (file downloads)
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        HTTPXClientInstrumentor().instrument()
    except Exception:
        pass

    # Auto-instrument aio-pika (RabbitMQ)
    try:
        from opentelemetry.instrumentation.aio_pika import AioPikaInstrumentor
        AioPikaInstrumentor().instrument()
    except Exception:
        pass

    print(f"[OpenTelemetry] Tracing enabled for service \"{service_name}\"")


class _NoOpSpan:
    """Minimal no-op span for when OpenTelemetry is not installed."""
    def set_attribute(self, key, value): pass
    def set_status(self, status): pass
    def record_exception(self, exc): pass
    def end(self): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass

class _NoOpTracer:
    """Minimal no-op tracer for when OpenTelemetry is not installed."""
    def start_as_current_span(self, name, **kwargs):
        return _NoOpSpan()


def get_tracer(name: str = "script_parser"):
    """Return a tracer — returns a no-op tracer if OTEL is disabled or packages missing."""
    try:
        from opentelemetry import trace
        return trace.get_tracer(name)
    except ImportError:
        return _NoOpTracer()
