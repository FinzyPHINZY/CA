// SessionFilesConsumer — receives analysis lifecycle events from ai_service
// over RMQ and reconciles them with the SessionSharedFile row. ai_service
// owns the parser dispatch but does not write to the core DB, so all
// SessionSharedFile mutations for analysis results happen here.

import {
  SESSION_FILE_EVENTS,
  type SessionFileAnalysisResultEvent,
} from '@app/common';
import { Controller, Injectable, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { SessionFilesService } from './session-files.service';

@Controller()
@Injectable()
export class SessionFilesConsumer {
  private readonly logger = new Logger(SessionFilesConsumer.name);

  constructor(private readonly sessionFilesService: SessionFilesService) {}

  @EventPattern(SESSION_FILE_EVENTS.ANALYSIS_RESULT)
  async handleAnalysisResult(
    @Payload() payload: SessionFileAnalysisResultEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef();
    const message = context.getMessage();

    try {
      await this.sessionFilesService.handleAnalysisResult(payload);
      channel.ack(message);
    } catch (err: any) {
      this.logger.error(
        `Failed to handle session file analysis result for sharedFile=${payload.sharedFileId}: ${err.message}`,
        err.stack,
      );
      // Nack without requeue — the row state will surface the failure to the
      // FE on next poll. Avoid retry storms on transient DB issues; a future
      // cron can sweep stuck PROCESSING rows if needed.
      channel.nack(message, false, false);
    }
  }
}
