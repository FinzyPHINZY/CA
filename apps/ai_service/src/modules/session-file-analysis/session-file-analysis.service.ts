// SessionFileAnalysisService — handles "Analyze" requests for files shared
// mid-call inside a Studio reader session.
//
// Flow:
//   1. Core emits SESSION_FILE_EVENTS.ANALYSIS_REQUESTED on demand.
//   2. We generate a task_id with the `sf_` prefix, stash correlation
//      in Redis, and dispatch a vanilla `script_parser.parse` job.
//   3. Python script_parser publishes the result back to ai_service.queue.
//      The existing `script_parser.result` handler branches on the `sf_`
//      prefix and delegates parsed results here.
//   4. We pull the correlation, build a SessionFileAnalysisResultEvent, and
//      emit SESSION_FILE_EVENTS.ANALYSIS_RESULT back to core.
//
// Crucially: no Script/Scene rows are written. This pipeline is throwaway by
// design — the result is consumed by SessionFilesService and stored in the
// SessionSharedFile row only.

import {
  CORE_SERVICE,
  SESSION_FILE_EVENTS,
  type SessionFileAnalysisRequestedEvent,
  type SessionFileAnalysisResultEvent,
  StorageService,
} from '@app/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { defaultIfEmpty } from 'rxjs/operators';
import type { ScriptParserResultMessage } from '../../contracts/script-parser.contract';

const SF_TASK_PREFIX = 'sf_';
const CORRELATION_KEY_PREFIX = 'sf_task:';
const CORRELATION_TTL_SECONDS = 24 * 60 * 60; // 24h — well beyond any reasonable parse window
const PRESIGNED_URL_TTL_SECONDS = 3600; // 1h — script_parser pulls within seconds typically

interface SfTaskCorrelation {
  sharedFileId: string;
  rehearsalId: string;
  requestedBy: string;
  fileName: string;
  startedAt: string;
}

@Injectable()
export class SessionFileAnalysisService {
  private readonly logger = new Logger(SessionFileAnalysisService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Inject('SCRIPT_PARSER_SERVICE')
    private readonly scriptParserClient: ClientProxy,
    @Inject(CORE_SERVICE) private readonly coreClient: ClientProxy,
    private readonly storageService: StorageService,
  ) {}

  // Returns true for task_ids issued by this service. The shared
  // ai_service.queue consumer uses this to route results away from the
  // Script/Scene write path.
  isSessionFileTask(taskId: string | null | undefined): boolean {
    return Boolean(taskId && taskId.startsWith(SF_TASK_PREFIX));
  }

  async dispatchAnalysis(
    event: SessionFileAnalysisRequestedEvent,
  ): Promise<void> {
    const taskId = `${SF_TASK_PREFIX}${randomUUID()}`;

    const correlation: SfTaskCorrelation = {
      sharedFileId: event.sharedFileId,
      rehearsalId: event.rehearsalId,
      requestedBy: event.requestedBy,
      fileName: event.fileName,
      startedAt: new Date().toISOString(),
    };
    await this.redis.set(
      `${CORRELATION_KEY_PREFIX}${taskId}`,
      JSON.stringify(correlation),
      'EX',
      CORRELATION_TTL_SECONDS,
    );

    // Python script_parser pulls the file from the S3 URL we hand it. The
    // presigned GET URL has its own TTL — keep it well above realistic
    // parse latency so retries inside the parser don't 403.
    const signed = await this.storageService.getSignedDownloadUrl(
      event.s3Key,
      PRESIGNED_URL_TTL_SECONDS,
    );

    const parserJob = {
      task_id: taskId,
      media_url: signed.url,
      file_name: event.fileName,
      file_extension: this.deriveExtension(event.extension, event.fileName),
      user_id: event.requestedBy,
      // project_id is required by the Python schema but unused for echo —
      // pass a sentinel so it's obvious in logs which jobs are session-file.
      project_id: 'session_shared_file',
      // script_id field is echoed back — repurpose as the sharedFileId so
      // downstream observability tooling can pivot without DB joins.
      script_id: event.sharedFileId,
      script_index: null,
      media_id: null,
    };

    await firstValueFrom(
      this.scriptParserClient
        .emit('script_parser.parse', parserJob)
        .pipe(defaultIfEmpty(null)),
    );

    this.logger.log(
      `[SessionFileAnalysis] Dispatched ${JSON.stringify({
        taskId,
        sharedFileId: event.sharedFileId,
        rehearsalId: event.rehearsalId,
        fileName: event.fileName,
      })}`,
    );
  }

  async handleParseResult(data: ScriptParserResultMessage): Promise<void> {
    const correlationKey = `${CORRELATION_KEY_PREFIX}${data.task_id}`;
    const raw = await this.redis.get(correlationKey);
    if (!raw) {
      this.logger.warn(
        `[SessionFileAnalysis] No correlation for task ${data.task_id} — likely TTL expired or stray result`,
      );
      return;
    }

    let correlation: SfTaskCorrelation;
    try {
      correlation = JSON.parse(raw) as SfTaskCorrelation;
    } catch (err: any) {
      this.logger.error(
        `[SessionFileAnalysis] Corrupt correlation payload for ${data.task_id}: ${err.message}`,
      );
      await this.redis.del(correlationKey);
      return;
    }

    // Burn the correlation immediately so a retry of the same parser result
    // (RMQ requeue) cannot trigger a duplicate ANALYSIS_RESULT emission.
    await this.redis.del(correlationKey);

    const isSuccess = data.status === 'SUCCESS' && data.result;
    const event: SessionFileAnalysisResultEvent = isSuccess
      ? {
          pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
          rehearsalId: correlation.rehearsalId,
          sharedFileId: correlation.sharedFileId,
          status: 'completed',
          result: data.result as unknown as Record<string, any>,
          completedAt: new Date().toISOString(),
        }
      : {
          pattern: SESSION_FILE_EVENTS.ANALYSIS_RESULT,
          rehearsalId: correlation.rehearsalId,
          sharedFileId: correlation.sharedFileId,
          status: 'failed',
          error: data.message ?? data.error ?? `Parser status: ${data.status}`,
          completedAt: new Date().toISOString(),
        };

    await firstValueFrom(
      this.coreClient
        .emit(SESSION_FILE_EVENTS.ANALYSIS_RESULT, event)
        .pipe(defaultIfEmpty(null)),
    );

    this.logger.log(
      `[SessionFileAnalysis] Result emitted ${JSON.stringify({
        taskId: data.task_id,
        sharedFileId: correlation.sharedFileId,
        rehearsalId: correlation.rehearsalId,
        status: event.status,
      })}`,
    );
  }

  private deriveExtension(extension: string, fileName: string): string {
    if (extension && extension.trim()) return extension.toLowerCase();
    const idx = fileName.lastIndexOf('.');
    if (idx < 0) return 'pdf';
    return fileName.slice(idx + 1).toLowerCase() || 'pdf';
  }
}
