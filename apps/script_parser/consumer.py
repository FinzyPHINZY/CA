"""
RabbitMQ consumer and publisher for the script_parser service.

Consumes from:   script_parser.queue
  Message: { task_id, media_url, file_name, file_extension, user_id, project_id, script_id }

Publishes to:    ai_service.queue
  Message: ParseResultMessage (see models/schema.py)

Retry strategy: Dead Letter Exchange (DLX) pattern — 30s, 2min, 10min delays.
On failure, message is published to a delay queue (not blocking the consumer).
After TTL expires, the message dead-letters back to the main queue for retry.
After 3 failed attempts: publish PARSE_FAILED with error details to the dead queue.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import datetime

import aio_pika
import httpx
import structlog

from models.schema import ParseJobMessage, ParseResultMessage, ParseResult
from pipeline.router import route_and_parse
from telemetry import get_tracer

log = structlog.get_logger()

_tracer = get_tracer()

import redis.asyncio as aioredis

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
SCRIPT_PARSER_QUEUE = os.getenv("SCRIPT_PARSER_QUEUE", "script_parser.queue")
SCRIPT_PARSER_RESULTS_QUEUE = os.getenv("SCRIPT_PARSER_RESULTS_QUEUE", "ai_service.queue")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
_IDEMPOTENCY_TTL = 86400  # 24 hours

# DLX retry configuration: delay queues with TTL (milliseconds)
_DELAY_TIERS = [
    {"queue": "script_parser.delay.30s", "ttl": 30_000},
    {"queue": "script_parser.delay.2m", "ttl": 120_000},
    {"queue": "script_parser.delay.10m", "ttl": 600_000},
]
_DEAD_QUEUE = "script_parser.dead"
_MAX_RETRIES = 3


async def _download_file(media_url: str) -> bytes:
    """Download script file from S3 presigned URL."""
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        response = await client.get(media_url)
        response.raise_for_status()
        return response.content


async def _publish_result(
    channel: aio_pika.Channel,
    result_msg: ParseResultMessage,
) -> None:
    """Publish a ParseResultMessage to the ai_service results queue."""
    await channel.declare_queue(
        SCRIPT_PARSER_RESULTS_QUEUE,
        durable=True,
    )
    # Wrap in NestJS RMQ envelope so @MessagePattern('script_parser.result') matches
    envelope = json.dumps({"pattern": "script_parser.result", "data": result_msg.model_dump()})
    await channel.default_exchange.publish(
        aio_pika.Message(envelope.encode(), delivery_mode=aio_pika.DeliveryMode.PERSISTENT),
        routing_key=SCRIPT_PARSER_RESULTS_QUEUE,
    )
    log.info(
        "result_published",
        task_id=result_msg.task_id,
        status=result_msg.status,
        queue=SCRIPT_PARSER_RESULTS_QUEUE,
    )


async def _process_job(
    job: ParseJobMessage,
    channel: aio_pika.Channel,
    attempt: int = 1,
) -> None:
    """Download file, run parse pipeline, publish result."""
    log.info(
        "job_received",
        task_id=job.task_id,
        extension=job.file_extension,
        attempt=attempt,
    )

    import time
    with _tracer.start_as_current_span("script.parse.download", attributes={
        "task_id": job.task_id, "extension": job.file_extension,
    }) as dl_span:
        download_start = time.monotonic()
        try:
            file_bytes = await _download_file(job.media_url)
        except Exception as exc:
            log.error("download_failed", task_id=job.task_id, error=str(exc))
            raise
        download_ms = int((time.monotonic() - download_start) * 1000)
        dl_span.set_attribute("download_duration_ms", download_ms)
        dl_span.set_attribute("file_size", len(file_bytes))
        log.info("file_downloaded", task_id=job.task_id, download_duration_ms=download_ms, file_size=len(file_bytes))

    # Compute content hash for duplicate detection (Task 12)
    content_hash = hashlib.sha256(file_bytes).hexdigest()

    with _tracer.start_as_current_span("script.parse.execute", attributes={
        "task_id": job.task_id, "extension": job.file_extension,
        "file_size": len(file_bytes),
    }) as parse_span:
        parse_start = time.monotonic()
        try:
            route_result = await asyncio.to_thread(
                route_and_parse, file_bytes, job.file_extension
            )
        except Exception as exc:
            log.error("parse_exception", task_id=job.task_id, error=str(exc))
            raise
        parse_ms = int((time.monotonic() - parse_start) * 1000)
        scene_count = len(route_result.result.scenes) if route_result.result else 0
        parse_span.set_attribute("parse_duration_ms", parse_ms)
        parse_span.set_attribute("scene_count", scene_count)
        log.info("parse_completed", task_id=job.task_id, parse_duration_ms=parse_ms, scene_count=scene_count)

        # Phase 0 observability: single structured line per parse capturing
        # every routing/feature-flag decision. One grep by task_id surfaces
        # the full parse path. Keys are stable for downstream log analytics.
        _result = route_result.result
        _dialogue_count = 0
        _action_count = 0
        if _result and _result.scenes:
            for _scene in _result.scenes:
                for _el in _scene.elements:
                    _t = getattr(_el.type, "value", _el.type)
                    if _t == "dialogue":
                        _dialogue_count += 1
                    elif _t == "action":
                        _action_count += 1
        log.info(
            "parse_summary",
            task_id=job.task_id,
            parser_path=route_result.parser_path,
            parser_chain=route_result.parser_chain,
            document_class=getattr(_result, "document_class", None) if _result else None,
            scene_count=scene_count,
            character_count=len(_result.characters) if _result else 0,
            dialogue_count=_dialogue_count,
            action_count=_action_count,
            confidence_score=_result.structure_confidence_score if _result else None,
            watermark_detected=_result.watermark_detected if _result else None,
            low_confidence_flag=_result.low_confidence_flag if _result else None,
            parser_warnings=_result.parser_warnings if _result else None,
            rejected=route_result.rejected,
            rejection_error=route_result.rejection_error,
            fix_flags={
                "sides_classification": False,
                "cont_d_normalize": False,
                "dialogue_merge": False,
                "margin_symmetric": False,
                "prologue_gate": False,
                "implicit_chars": False,
            },
        )

    if route_result.rejected:
        # NEEDS_OCR is not a terminal failure — it signals the ai_service
        # to use its own Document AI / Adobe Extract for OCR extraction.
        status = "NEEDS_OCR" if route_result.rejection_error == "NEEDS_OCR" else "VALIDATION_FAILED"
        result_msg = ParseResultMessage(
            task_id=job.task_id,
            script_id=job.script_id,
            user_id=job.user_id,
            status=status,
            error=route_result.rejection_error,  # type: ignore[arg-type]
            message=route_result.rejection_message,
            confidence_score=route_result.result.structure_confidence_score or None,
            native_extraction=route_result.native_extraction,
            file_name=job.file_name,
            project_id=job.project_id,
            script_index=job.script_index,
            content_hash=content_hash,
            media_url=job.media_url,
            parser_path=route_result.parser_path,
            parser_chain=route_result.parser_chain,
        )
    else:
        result_msg = ParseResultMessage(
            task_id=job.task_id,
            script_id=job.script_id,
            user_id=job.user_id,
            status="SUCCESS",
            result=route_result.result,
            native_extraction=route_result.native_extraction,
            file_name=job.file_name,
            project_id=job.project_id,
            script_index=job.script_index,
            content_hash=content_hash,
            parser_path=route_result.parser_path,
            parser_chain=route_result.parser_chain,
        )

    await _publish_result(channel, result_msg)


async def _declare_delay_infrastructure(channel: aio_pika.Channel) -> None:
    """Declare the DLX delay queues and dead queue at startup."""
    for tier in _DELAY_TIERS:
        await channel.declare_queue(
            tier["queue"],
            durable=True,
            arguments={
                "x-message-ttl": tier["ttl"],
                "x-dead-letter-exchange": "",  # default exchange
                "x-dead-letter-routing-key": SCRIPT_PARSER_QUEUE,
            },
        )
        log.info("delay_queue_declared", queue=tier["queue"], ttl_ms=tier["ttl"])

    await channel.declare_queue(_DEAD_QUEUE, durable=True)
    log.info("dead_queue_declared", queue=_DEAD_QUEUE)


def _get_retry_count(message: aio_pika.IncomingMessage) -> int:
    """Extract retry count from message headers."""
    if message.headers and "x-retry-count" in message.headers:
        return int(message.headers["x-retry-count"])
    return 0


async def _publish_to_delay_queue(
    channel: aio_pika.Channel,
    original_body: bytes,
    retry_count: int,
    error_msg: str,
) -> None:
    """Publish the message to the appropriate delay queue for retry."""
    tier_index = min(retry_count, len(_DELAY_TIERS) - 1)
    delay_queue = _DELAY_TIERS[tier_index]["queue"]

    headers = {
        "x-retry-count": retry_count + 1,
        "x-last-error": error_msg[:500],
        "x-last-retry-at": datetime.utcnow().isoformat(),
    }

    await channel.default_exchange.publish(
        aio_pika.Message(
            original_body,
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            headers=headers,
        ),
        routing_key=delay_queue,
    )
    log.info(
        "message_sent_to_delay_queue",
        delay_queue=delay_queue,
        retry_count=retry_count + 1,
    )


async def _publish_to_dead_queue(
    channel: aio_pika.Channel,
    original_body: bytes,
    retry_count: int,
    error_msg: str,
) -> None:
    """Publish the message to the dead queue after exhausting retries."""
    headers = {
        "x-retry-count": retry_count,
        "x-final-error": error_msg[:1000],
        "x-dead-at": datetime.utcnow().isoformat(),
    }

    await channel.default_exchange.publish(
        aio_pika.Message(
            original_body,
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            headers=headers,
        ),
        routing_key=_DEAD_QUEUE,
    )
    log.info("message_sent_to_dead_queue", retry_count=retry_count)


async def start_consumer(connection: aio_pika.Connection) -> None:
    """Set up the consumer and start processing messages."""
    channel = await connection.channel()
    await channel.set_qos(prefetch_count=5)

    # Declare main queue and DLX infrastructure
    queue = await channel.declare_queue(SCRIPT_PARSER_QUEUE, durable=True)
    await _declare_delay_infrastructure(channel)

    # Connect to Redis for idempotency checks
    redis_client: aioredis.Redis | None = None
    try:
        redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
        await redis_client.ping()
        log.info("redis_connected", url=REDIS_URL)
    except Exception as exc:
        log.warning("redis_connection_failed", error=str(exc))
        redis_client = None

    log.info("consumer_started", queue=SCRIPT_PARSER_QUEUE)

    async with queue.iterator(no_ack=False) as queue_iter:
        async for message in queue_iter:
            # Process each message concurrently — prefetch_count=5 allows
            # up to 5 in-flight messages. asyncio.create_task lets the consumer
            # loop pick up the next message while previous ones are still processing.
            asyncio.create_task(_handle_message(message, channel, redis_client))


async def _handle_message(
    message: aio_pika.IncomingMessage,
    channel: aio_pika.Channel,
    redis_client: aioredis.Redis | None = None,
) -> None:
    """Handle a single message: process, ack, and route failures to delay/dead queues."""
    retry_count = _get_retry_count(message)

    try:
        body = json.loads(message.body.decode())
        # NestJS ClientProxy wraps payloads as {"pattern": "...", "data": {...}}
        payload = body.get("data", body)
        job = ParseJobMessage(**payload)

        # Idempotency check — skip if already processed
        if redis_client and job.task_id:
            was_set = await redis_client.set(
                f"parsed:{job.task_id}", "1", ex=_IDEMPOTENCY_TTL, nx=True
            )
            if not was_set:
                log.info("duplicate_job_skipped", task_id=job.task_id)
                await message.ack()
                return

        await _process_job(job, channel, attempt=retry_count + 1)
        await message.ack()
    except Exception as exc:
        error_msg = str(exc)
        log.warning(
            "job_attempt_failed",
            retry_count=retry_count,
            error=error_msg,
        )

        # Ack the original message (we'll re-enqueue via delay queue or dead queue)
        await message.ack()

        if retry_count + 1 >= _MAX_RETRIES:
            # Exhausted all retries — send to dead queue and publish PARSE_FAILED
            log.error("job_all_retries_exhausted", retry_count=retry_count, error=error_msg)
            await _publish_to_dead_queue(channel, message.body, retry_count + 1, error_msg)

            # Publish PARSE_FAILED result so ai_service/core know the job is terminal
            try:
                payload = json.loads(message.body.decode())
                data = payload.get("data", payload)
                fail_msg = ParseResultMessage(
                    task_id=data.get("task_id", "unknown"),
                    script_id=data.get("script_id"),
                    user_id=data.get("user_id"),
                    status="PARSE_FAILED",
                    error="PARSE_ERROR",
                    message=f"Parsing failed after {_MAX_RETRIES} attempts: {error_msg}",
                    file_name=data.get("file_name"),
                    project_id=data.get("project_id"),
                    script_index=data.get("script_index"),
                )
                await _publish_result(channel, fail_msg)
            except Exception as pub_exc:
                log.error("failed_to_publish_failure_result", error=str(pub_exc))
        else:
            # Retry — publish to delay queue (consumer is immediately free)
            await _publish_to_delay_queue(channel, message.body, retry_count, error_msg)
