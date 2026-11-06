// hazel-recording consumer — receives lifecycle events from ai_service over RMQ
// and reconciles them with the Recording table. ai_service cannot write to the
// shared DB, so all Recording row mutations for Hazel sessions happen here.
//
// Events handled:
//   HAZEL_RECORDING_EVENTS.STARTED        → insert Recording row (status=RECORDING)
//   HAZEL_RECORDING_EVENTS.STOP_REQUESTED → delegate to HazelRecordingFinalizerService

import {
  HAZEL_RECORDING_EVENTS,
  type HazelRecordingStartedEvent,
  type HazelRecordingStopRequestedEvent,
  RecordingMode,
  RecordingRepository,
  RecordingStatus,
  RecordingTypeEnum,
  RehersalRepository,
} from '@app/common';
import { Controller, Injectable, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { HazelRecordingFinalizerService } from './hazel-recording-finalizer.service';

@Controller()
@Injectable()
export class HazelRecordingConsumer {
  private readonly logger = new Logger(HazelRecordingConsumer.name);

  constructor(
    private readonly recordingRepository: RecordingRepository,
    private readonly rehersalRepository: RehersalRepository,
    private readonly finalizer: HazelRecordingFinalizerService,
  ) {}

  @EventPattern(HAZEL_RECORDING_EVENTS.STARTED)
  async handleHazelRecordingStarted(
    @Payload() payload: Omit<HazelRecordingStartedEvent, 'pattern'>,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef();
    const message = context.getMessage();

    const {
      rehearsalId,
      userId,
      agoraChannelId,
      agoraResourceId,
      agoraSid,
      startedAt,
    } = payload;

    const logTag = `[Hazel reh=${rehearsalId} sid=${agoraSid}]`;
    this.logger.log(
      `${logTag} STARTED event received — resourceId=${agoraResourceId} channel=${agoraChannelId} userId=${userId}`,
    );

    try {
      // idempotency guard — RMQ is at-least-once, so a redelivery must not
      // create a second Recording row for the same Agora session.
      const existing = await this.recordingRepository.findOne({
        where: { agoraResourceId, cloudRecordingSid: agoraSid },
        withDeleted: false,
      });

      if (existing) {
        this.logger.warn(
          `${logTag} duplicate STARTED — recording=${existing.id} already exists, skipping insert`,
        );
        channel.ack(message);
        return;
      }

      // rehearsal carries the scene/script/project FKs required by Recording.
      // booking-only rehearsals may have these null — Hazel sessions are
      // scene-based today, but guard defensively.
      const rehearsal = await this.rehersalRepository.findById(rehearsalId);
      if (!rehearsal) {
        this.logger.error(
          `${logTag} STARTED references missing rehearsal — dropping (ack to prevent redelivery loop)`,
        );
        channel.ack(message);
        return;
      }

      if (!rehearsal.projectId || !rehearsal.scriptId || !rehearsal.sceneId) {
        this.logger.error(
          `${logTag} rehearsal missing FKs (projectId=${rehearsal.projectId}, scriptId=${rehearsal.scriptId}, sceneId=${rehearsal.sceneId}) — cannot create Recording row`,
        );
        channel.ack(message);
        return;
      }

      const recording = await this.recordingRepository.createEntity({
        type: RecordingTypeEnum.AI_PARTNER,
        mode: RecordingMode.AI_REHEARSAL,
        status: RecordingStatus.RECORDING,
        agoraChannelId,
        agoraResourceId,
        cloudRecordingSid: agoraSid,
        projectId: rehearsal.projectId,
        scriptId: rehearsal.scriptId,
        sceneId: rehearsal.sceneId,
        userId,
        rehearsalId,
        metaData: {
          source: 'hazel',
          startedAt,
        },
      } as any);

      this.logger.log(
        `${logTag} Recording row created: id=${recording.id} status=RECORDING`,
      );
      channel.ack(message);
    } catch (err: any) {
      // transient failure (DB connection, etc.) — do not ack so RMQ redelivers
      // after the consumer acknowledgment timeout.
      this.logger.error(
        `${logTag} failed to process STARTED: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  @EventPattern(HAZEL_RECORDING_EVENTS.STOP_REQUESTED)
  async handleHazelRecordingStopRequested(
    @Payload() payload: Omit<HazelRecordingStopRequestedEvent, 'pattern'>,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef();
    const message = context.getMessage();

    const { rehearsalId, agoraResourceId, agoraSid } = payload;
    const logTag = `[Hazel reh=${rehearsalId} sid=${agoraSid}]`;

    this.logger.log(
      `${logTag} STOP_REQUESTED event received — resourceId=${agoraResourceId}`,
    );

    try {
      const recording = await this.recordingRepository.findOne({
        where: { agoraResourceId, cloudRecordingSid: agoraSid },
        relations: ['takes'],
        withDeleted: false,
      });

      // STARTED may not have landed yet (out-of-order delivery), or the row
      // was wiped. Drop with a warning — without the row we cannot reconcile.
      if (!recording) {
        this.logger.warn(
          `${logTag} STOP_REQUESTED for unknown recording — STARTED may not have been processed; dropping`,
        );
        channel.ack(message);
        return;
      }

      // idempotency — a finalized recording must not be re-processed. Skip
      // both READY and FAILED so a duplicate stop doesn't reopen an aborted
      // recording or create duplicate Media rows.
      if (
        recording.status === RecordingStatus.READY ||
        recording.status === RecordingStatus.FAILED
      ) {
        this.logger.warn(
          `${logTag} recording=${recording.id} already finalized (status=${recording.status}); skipping duplicate STOP_REQUESTED`,
        );
        channel.ack(message);
        return;
      }

      await this.finalizer.finalize(recording, 'user_ended');
      channel.ack(message);
    } catch (err: any) {
      this.logger.error(
        `${logTag} failed to process STOP_REQUESTED: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }
}
