// Receives Agora NCS (Notification Callback Service) webhook events that
// belong to Hazel recording channels (cname starts with `hazel_rec_`).
//
// Agora cloud recording emits NCS events asynchronously through its session:
//   eventType 1   — cloud_recording_error (carries errorCode + errorLevel)
//   eventType 11  — session_exit
//   eventType 30  — uploader status (uploader_started / uploader_finished)
//   eventType 41  — recorder_leave (carries leaveCode)
//
// We do NOT change Recording state from here — the finalizer + monitor own
// the lifecycle. This handler is purely diagnostic: it persists the raw
// errorCode / leaveCode into recording.metaData.ncsEvents so we can grep
// the DB after-the-fact to understand WHY a recording produced no media.
//
// On critical errors (errorCode 110 = "no streams found", recorder_leave
// with leaveCode 16 = no users in channel), we also surface a warn log so
// the cause shows up in our staging logs alongside the rest of the Hazel
// lifecycle.

import { RecordingRepository } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';

interface NcsPayload {
  cname?: string;
  channelName?: string;
  sid?: string;
  sequence?: number;
  serviceScene?: string;
  serviceType?: number;
  details?: {
    errorCode?: number;
    errorLevel?: number;
    errorMsg?: string;
    module?: number;
    msgName?: string;
    stat?: number;
    leaveCode?: number;
    exitStatus?: number;
    status?: number;
  };
}

@Injectable()
export class HazelNcsHandlerService {
  private readonly logger = new Logger(HazelNcsHandlerService.name);

  constructor(private readonly recordingRepository: RecordingRepository) {}

  static isHazelChannel(channelName: string | undefined): boolean {
    return typeof channelName === 'string' && channelName.startsWith('hazel_rec_');
  }

  async handleEvent(
    eventType: number,
    payload: NcsPayload,
    productId?: number,
  ): Promise<void> {
    const channelName = payload?.cname ?? payload?.channelName;
    const sid = payload?.sid;
    const details = payload?.details ?? {};
    const msgName = details.msgName;
    const errorCode = details.errorCode;
    const leaveCode = details.leaveCode;

    const logTag = `[HazelNCS channel=${channelName} sid=${sid}]`;

    // Critical error path — Agora couldn't subscribe to anyone in the channel.
    // This is the most common cause of `no_media_produced`: actor's frontend
    // joined too late (after the bot's startup subscription window).
    if (eventType === 1 && errorCode === 110) {
      this.logger.warn(
        `${logTag} cloud_recording_error errorCode=110 errorLevel=${details.errorLevel} — bot found no streams to subscribe to (frontend likely joined channel AFTER bot started). msgName=${msgName} module=${details.module}`,
      );
    }

    // recorder_leave with leaveCode 16 = bot left because channel was empty.
    if (eventType === 41 && leaveCode === 16) {
      this.logger.warn(
        `${logTag} recorder_leave leaveCode=16 — bot left because no user was publishing in the channel.`,
      );
    }

    // All other events — log at info so we have a full audit trail.
    if (eventType !== 1 && eventType !== 41) {
      this.logger.log(
        `${logTag} NCS event eventType=${eventType} productId=${productId} msgName=${msgName ?? 'n/a'} details=${JSON.stringify(details)}`,
      );
    }

    // Persist the event into recording.metaData.ncsEvents (append-only) so
    // we can audit after the fact. Best-effort: skip silently if the row
    // doesn't exist yet (NCS events can arrive before STARTED is consumed).
    if (!sid) return;
    try {
      const recording = await this.recordingRepository.findOne({
        where: { cloudRecordingSid: sid },
        withDeleted: false,
      });
      if (!recording) return;

      const existing = (recording.metaData as any) ?? {};
      const ncsEvents = Array.isArray(existing.ncsEvents)
        ? existing.ncsEvents
        : [];
      ncsEvents.push({
        ts: new Date().toISOString(),
        eventType,
        productId,
        msgName,
        errorCode,
        errorLevel: details.errorLevel,
        leaveCode,
        exitStatus: details.exitStatus,
        status: details.status,
      });
      // cap to last 50 events to bound JSONB size
      const capped = ncsEvents.slice(-50);
      await this.recordingRepository.update(recording.id, {
        metaData: { ...existing, ncsEvents: capped },
      } as any);
    } catch (err: any) {
      this.logger.error(
        `${logTag} failed to persist NCS event into recording.metaData: ${err.message}`,
      );
    }
  }
}
