"""
Script Parser Service — FastAPI entry point (task 4.0.1).

Exposes:
  GET /health   — health check (for Docker HEALTHCHECK and service mesh)
  GET /         — service info

The RabbitMQ consumer runs as a background asyncio task started on app startup.
This means the process has two concerns: serving HTTP (uvicorn) and consuming
messages (aio-pika). Both run in the same event loop via asyncio.create_task().
"""
from __future__ import annotations

# OpenTelemetry must init before other imports
from telemetry import init_tracing
init_tracing()

import asyncio
import os

import aio_pika
import anyio
import structlog
from fastapi import FastAPI, HTTPException, Request

from consumer import start_consumer
from smart_turn import SmartTurn, pcm16_to_float32

log = structlog.get_logger()

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/")

app = FastAPI(
    title="CueActor Script Parser",
    description=(
        "Deterministic multi-format screenplay parser. "
        "Consumes parse jobs from RabbitMQ, routes to the correct parser, "
        "validates structure, and publishes ParseResult to the results queue."
    ),
    version="1.0.0",
)

_connection: aio_pika.Connection | None = None
_consumer_task: asyncio.Task | None = None
_smart_turn: SmartTurn | None = None


async def _connect_with_retry(max_attempts: int = 10, delay: float = 3.0) -> aio_pika.Connection:
    """Connect to RabbitMQ with retries (service may not be ready immediately)."""
    for attempt in range(1, max_attempts + 1):
        try:
            connection = await aio_pika.connect_robust(RABBITMQ_URL)
            log.info("rabbitmq_connected", attempt=attempt)
            return connection
        except Exception as exc:
            log.warning("rabbitmq_connect_failed", attempt=attempt, error=str(exc))
            if attempt < max_attempts:
                await asyncio.sleep(delay)
    raise RuntimeError(f"Could not connect to RabbitMQ after {max_attempts} attempts")


@app.on_event("startup")
async def on_startup() -> None:
    global _connection, _consumer_task, _smart_turn

    log.info("script_parser_starting")

    # Load the smart-turn model once. Failure here must not crash the HTTP
    # server — the /smart-turn/check endpoint returns 503 if it's unavailable.
    try:
        _smart_turn = SmartTurn()
    except Exception as exc:
        log.error("smart_turn_load_failed", error=str(exc))

    try:
        _connection = await _connect_with_retry()
        _consumer_task = asyncio.create_task(start_consumer(_connection))
        log.info("consumer_task_started")
    except Exception as exc:
        log.error("startup_failed", error=str(exc))
        # we don't crash the HTTP server; health check will show degraded state


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _connection, _consumer_task

    log.info("script_parser_shutting_down")
    if _consumer_task:
        _consumer_task.cancel()
    if _connection and not _connection.is_closed:
        await _connection.close()


@app.get("/health")
async def health() -> dict:
    """Health check endpoint (task 4.0.1)."""
    consumer_healthy = (
        _consumer_task is not None
        and not _consumer_task.done()
    )
    rmq_connected = (
        _connection is not None
        and not _connection.is_closed
    )
    return {
        "status": "healthy" if (consumer_healthy and rmq_connected) else "degraded",
        "consumer_running": consumer_healthy,
        "rabbitmq_connected": rmq_connected,
        "smart_turn_loaded": _smart_turn is not None,
    }


@app.post("/smart-turn/check")
async def smart_turn_check(request: Request) -> dict:
    """Turn-detection inference.

    Body: raw little-endian Int16 PCM, 16 kHz, mono — the last <=8s of the
    actor's current utterance. Returns the turn-completion probability.

    Internal endpoint: reached only via the ai_service proxy on the private
    network (auth is enforced there), so no JWT check here.
    """
    if _smart_turn is None:
        raise HTTPException(status_code=503, detail="smart-turn model not loaded")

    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio body")
    if len(raw) % 2 != 0:
        raise HTTPException(status_code=400, detail="body is not Int16 PCM (odd length)")

    audio = pcm16_to_float32(raw)
    if audio.shape[0] == 0:
        raise HTTPException(status_code=400, detail="no audio samples")

    # ONNX inference is CPU-bound and blocking — run off the event loop.
    result = await anyio.to_thread.run_sync(_smart_turn.check, audio)
    return result


@app.get("/")
async def root() -> dict:
    return {
        "service": "script_parser",
        "version": "1.0.0",
        "description": "CueActor deterministic screenplay parser",
        "queues": {
            "consumes": os.getenv("SCRIPT_PARSER_QUEUE", "script_parser.queue"),
            "publishes": os.getenv("SCRIPT_PARSER_RESULTS_QUEUE", "ai_service.queue"),
        },
    }
