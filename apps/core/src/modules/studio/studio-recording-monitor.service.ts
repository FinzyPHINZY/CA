/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { AgoraSessionRepository } from '@app/common';
import { AgoraSessionStatus } from '@app/common/enums/studio.enum';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StudioRecordingService } from './studio-recording.service';

// background job that queries active cloud recordings every 30 seconds.
// detects stuck or failed recordings and logs alerts.
@Injectable()
export class StudioRecordingMonitorService {
  private readonly logger = new Logger(StudioRecordingMonitorService.name);

  constructor(
    private readonly agoraSessionRepository: AgoraSessionRepository,
    private readonly studioRecordingService: StudioRecordingService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkActiveRecordings(): Promise<void> {
    // find all sessions that are in RECORDING status
    const activeSessions = await this.agoraSessionRepository
      .createQueryBuilder('session')
      .where('session.status = :status', {
        status: AgoraSessionStatus.RECORDING,
      })
      .andWhere('session.agoraResourceId IS NOT NULL')
      .andWhere('session.agoraSid IS NOT NULL')
      .andWhere('session.deletedAt IS NULL')
      .getMany();

    if (activeSessions.length === 0) return;

    this.logger.debug(
      `Checking ${activeSessions.length} active cloud recording(s)...`,
    );

    for (const session of activeSessions) {
      try {
        const result =
          await this.studioRecordingService.queryRecording(session);

        if (!result) continue;

        // Agora recording status codes:
        // 5 = recording normally
        // 6 = paused
        // 7 = stopped
        // 8 = exited
        const { status } = result;

        if (status === 7 || status === 8) {
          // recording stopped unexpectedly
          this.logger.warn(
            `Recording for session ${session.id} (channel: ${session.channelName}) stopped unexpectedly. Status: ${status}`,
          );

          // stop and finalize
          try {
            await this.studioRecordingService.stopRecording(session);
          } catch {
            // stopRecording may fail if Agora already cleaned up — that's ok
          }

          await this.agoraSessionRepository.updateById(session.id, {
            status: AgoraSessionStatus.ENDED,
            endedAt: new Date(),
          } as any);
        } else if (status === 6) {
          this.logger.warn(
            `Recording for session ${session.id} is paused. This may indicate an issue.`,
          );
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to check recording status for session ${session.id}: ${error.message}`,
        );

        // If Agora returns 400, the resource/sid is invalid or expired —
        // the recording no longer exists. Finalize the session so we stop
        // polling it every 30 seconds.
        const statusCode =
          error?.status ??
          error?.response?.status ??
          error?.response?.statusCode;
        if (statusCode === 400) {
          this.logger.warn(
            `Finalizing stale recording session ${session.id} — Agora resource no longer exists.`,
          );
          await this.agoraSessionRepository.updateById(session.id, {
            status: AgoraSessionStatus.ENDED,
            endedAt: new Date(),
          } as any);
        }
      }
    }
  }
}
