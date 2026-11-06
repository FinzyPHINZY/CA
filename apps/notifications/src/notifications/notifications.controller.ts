/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  CORE_SERVICE,
  HAZEL_RECORDING_EVENTS,
  NotificationRepository,
  NotificationType,
  SESSION_FILE_EVENTS,
  SESSION_FILE_SOCKET_EVENTS,
  type SessionFileAnalyzedEvent,
  type SessionFileAnalyzingEvent,
  type SessionFileDeletedEvent,
  type SessionFileSharedEvent,
} from '@app/common';
import { Controller, Inject, Logger } from '@nestjs/common';
import {
  ClientProxy,
  Ctx,
  EventPattern,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

// NOTE: In NestJS v10 RMQ transport, both @MessagePattern and @EventPattern
// route to the same handler map, so either works with emit(). We use
// @EventPattern for handlers triggered by fire-and-forget emit() calls
// for semantic correctness (no response expected).
import { NotificationQueueService } from '../websocket/notification-queue.service';
import { SessionChatService } from '../websocket/session-chat.service';
import { TeleprompterGateway } from '../websocket/teleprompter.gateway';
import { NotificationsGateway } from '../websocket/websocket.gateway';
import { SendNotificationDto } from './dto/send-notification.dto';
import { NotificationsService } from './notifications.service';

@Controller()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationQueueService: NotificationQueueService,
    private readonly notificationRepository: NotificationRepository,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly sessionChatService: SessionChatService,
    private readonly teleprompterGateway: TeleprompterGateway,
    @Inject(CORE_SERVICE) private readonly coreClient: ClientProxy,
  ) {}

  @MessagePattern('notifications.send')
  async send(@Payload() dto: SendNotificationDto) {
    return this.notificationsService.send(dto);
  }

  @EventPattern('booking.status_changed')
  async handleBookingStatusChanged(
    @Payload()
    payload: {
      type: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      sessionStartUtc: string;
      sessionEndUtc: string;
      sessionDurationMinutes: number;
      priceCents: number;
      currency: string;
      actorIcsContent?: string;
      readerIcsContent?: string;
      cancellationReason?: string;
      cancelledBy?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received booking.status_changed: ${payload.type} for booking ${payload.bookingId}`,
    );
    try {
      if (payload.type === 'booking.confirmed') {
        await this.notificationsService.sendBookingConfirmedEmails(payload);
      } else if (payload.type === 'booking.cancelled') {
        await this.handleBookingCancelled(payload);
      }
      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle booking.status_changed: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // Consume jobs from RabbitMQ; manual ack after successful processing
  @EventPattern('notification.created')
  async handleJob(
    @Payload() dto: SendNotificationDto,
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received notification.created event: ${JSON.stringify(dto)}`,
    );
    try {
      await this.notificationsService.send(dto);
      this.logger.log(
        `Notification processed successfully for user ${dto.recipientUserId}`,
      );
      const channel = context.getChannelRef();
      const originalMessage = context.getMessage();
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        `Failed to process notification: ${error.message}`,
        error.stack,
      );
      // Don't ack on error so message can be retried
      throw error;
    }
  }

  /**
   * Handle analysis progress events from RabbitMQ
   */
  @EventPattern('script-analysis.progress')
  async handleAnalysisProgress(
    @Payload()
    payload: {
      taskId: string;
      userId: string;
      progressMessage: string;
      progress?: number;
      step?: string;
      scriptName?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received analysis.progress event for task ${payload.taskId}`,
    );
    try {
      // Forward to WebSocket queue for real-time notifications
      await this.notificationQueueService.addProgressEvent(payload);

      // Create or update a single SCRIPT_ANALYSIS notification per task.
      // This avoids notification bloat by reusing the same record for
      // progress updates and final completion.
      try {
        const existing = await this.notificationRepository.findOne({
          where: {
            recipientUserId: payload.userId,
            taskId: payload.taskId,
            notificationType: NotificationType.SCRIPT_ANALYSIS,
          } as any,
          order: { createdAt: 'DESC' },
        });

        const title =
          payload.progress !== undefined
            ? `Script Analysis Progress: ${payload.progress}%`
            : 'Script Analysis In Progress';

        const updateData: Partial<any> = {
          scriptName: payload.scriptName || existing?.scriptName || null,
          title,
          body: payload.progressMessage,
          progress:
            payload.progress !== undefined
              ? payload.progress
              : (existing?.progress ?? null),
          progressMessage: payload.progressMessage,
          step: payload.step || null,
          read: false,
        };

        if (existing) {
          await this.notificationRepository.updateById(existing.id, updateData);
          this.logger.log(
            `Updated script analysis progress notification for task ${payload.taskId}`,
          );
        } else {
          await this.notificationRepository.createNotification({
            recipientUserId: payload.userId,
            notificationType: NotificationType.SCRIPT_ANALYSIS,
            taskId: payload.taskId,
            ...updateData,
          });
          this.logger.log(
            `Created script analysis progress notification for task ${payload.taskId}`,
          );
        }
      } catch (notifError) {
        this.logger.error(
          `Failed to upsert progress notification: ${notifError.message}`,
          notifError.stack,
        );
        // Do not fail the message on notification errors
      }

      const channel = context.getChannelRef();
      const originalMessage = context.getMessage();
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        `Failed to process analysis.progress: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // handle recording retention warning — recording expires soon
  @EventPattern('recording.retention_warning')
  async handleRecordingRetentionWarning(
    @Payload()
    payload: {
      recipientUserId: string;
      recordingId: string;
      daysRemaining: number;
      plan: string;
      retentionDays: number;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received recording.retention_warning for recording ${payload.recordingId}`,
    );
    try {
      await this.notificationRepository.createNotification({
        recipientUserId: payload.recipientUserId,
        notificationType: NotificationType.RECORDING,
        title: `Recording expires in ${payload.daysRemaining} days`,
        body: `Your recording will be removed in ${payload.daysRemaining} days due to your ${payload.plan} plan's ${payload.retentionDays}-day retention policy. Download it or upgrade your plan to keep it longer.`,
        read: false,
      });

      await this.notificationsService.send({
        recipientUserId: payload.recipientUserId,
        title: `Recording expires in ${payload.daysRemaining} days`,
        body: `Your recording will be removed in ${payload.daysRemaining} days.`,
        channels: ['email'],
        template: 'recording-retention-warning',
        data: {
          daysRemaining: payload.daysRemaining,
          plan: payload.plan,
          retentionDays: payload.retentionDays,
          recordingId: payload.recordingId,
        },
      });

      const channel = context.getChannelRef();
      const originalMessage = context.getMessage();
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        `Failed to process recording.retention_warning: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // handle recording retention deleted — recording was removed
  @EventPattern('recording.retention_deleted')
  async handleRecordingRetentionDeleted(
    @Payload()
    payload: {
      recipientUserId: string;
      recordingId: string;
      plan: string;
      retentionDays: number;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received recording.retention_deleted for recording ${payload.recordingId}`,
    );
    try {
      await this.notificationRepository.createNotification({
        recipientUserId: payload.recipientUserId,
        notificationType: NotificationType.RECORDING,
        title: 'A recording has been removed',
        body: `A recording was removed after exceeding your ${payload.plan} plan's ${payload.retentionDays}-day retention period. Upgrade your plan for longer retention.`,
        read: false,
      });

      await this.notificationsService.send({
        recipientUserId: payload.recipientUserId,
        title: 'A recording has been removed',
        body: `A recording was removed after exceeding your retention period.`,
        channels: ['email'],
        template: 'recording-retention-deleted',
        data: {
          plan: payload.plan,
          retentionDays: payload.retentionDays,
          recordingId: payload.recordingId,
        },
      });

      const channel = context.getChannelRef();
      const originalMessage = context.getMessage();
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        `Failed to process recording.retention_deleted: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // handle analysis completion events from RabbitMQ
  @EventPattern('script-analysis.completed')
  async handleAnalysisCompleted(
    @Payload()
    payload: {
      taskId: string;
      userId: string;
      scriptIndex?: number; // Index of script in project
      scriptName?: string;
      resultMetadata: {
        status: 'success' | 'failed';
        message?: string;
        error?: string;
      };
      result?: any; // Full analysis result from AI service
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received analysis.completed event for task ${payload.taskId}`,
    );
    try {
      // forward to WebSocket queue for real-time notifications
      await this.notificationQueueService.addCompletionEvent(payload);

      // create or update a single SCRIPT_ANALYSIS notification per task.
      try {
        const existing = await this.notificationRepository.findOne({
          where: {
            recipientUserId: payload.userId,
            taskId: payload.taskId,
            notificationType: NotificationType.SCRIPT_ANALYSIS,
          } as any,
          order: { createdAt: 'DESC' },
        });

        const title =
          payload.resultMetadata.status === 'success'
            ? 'Script Analysis Completed Successfully'
            : 'Script Analysis Failed';
        const body =
          payload.resultMetadata.status === 'success'
            ? payload.resultMetadata.message ||
              'Your script analysis has been completed successfully.'
            : payload.resultMetadata.error ||
              'An error occurred during script analysis.';

        const updateData: Partial<any> = {
          scriptName: payload.scriptName || existing?.scriptName || null,
          title,
          body,
          progress: 100,
          progressMessage: body,
          scriptIndex: payload.scriptIndex ?? existing?.scriptIndex ?? null,
          resultMetadata: payload.resultMetadata,
          result: payload.result || existing?.result || null,
          read: false,
        };

        if (existing) {
          await this.notificationRepository.updateById(existing.id, updateData);
          this.logger.log(
            `Updated completion notification for script analysis task ${payload.taskId}`,
          );
        } else {
          await this.notificationRepository.createNotification({
            recipientUserId: payload.userId,
            notificationType: NotificationType.SCRIPT_ANALYSIS,
            taskId: payload.taskId,
            ...updateData,
          });
          this.logger.log(
            `Created completion notification for script analysis task ${payload.taskId}`,
          );
        }
      } catch (notifError) {
        this.logger.error(
          `Failed to upsert completion notification: ${notifError.message}`,
          notifError.stack,
        );
        // Don't fail the entire operation if notification creation fails
      }

      // Forward result to core service for database storage
      if (payload.result) {
        this.coreClient.emit('analysis.result.store', {
          taskId: payload.taskId,
          userId: payload.userId,
          result: payload.result,
          status: payload.resultMetadata.status,
          error: payload.resultMetadata.error,
        });
        this.logger.log(
          `Forwarded analysis result to core service for task ${payload.taskId}`,
        );
      }

      // PM request: suppress script-analysis completion email. Restore by uncommenting.
      // try {
      //   const isSuccess = payload.resultMetadata.status === 'success';
      //   await this.notificationsService.send({
      //     recipientUserId: payload.userId,
      //     title: isSuccess
      //       ? 'Your script analysis is complete'
      //       : 'Script analysis failed',
      //     body: isSuccess
      //       ? `Your script "${payload.scriptName || 'Untitled'}" has been analyzed.`
      //       : `Analysis of "${payload.scriptName || 'Untitled'}" could not be completed.`,
      //     channels: ['email'],
      //     template: 'script-analysis-completed',
      //     data: {
      //       scriptName: payload.scriptName || 'Untitled',
      //       isSuccess,
      //       errorMessage: payload.resultMetadata.error || null,
      //     },
      //   });
      // } catch (emailError) {
      //   this.logger.error(
      //     `Failed to send analysis completed email: ${emailError.message}`,
      //   );
      // }

      const channel = context.getChannelRef();
      const originalMessage = context.getMessage();
      channel.ack(originalMessage);
    } catch (error) {
      this.logger.error(
        `Failed to process analysis.completed: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ── Instant Connect Events ─────────────────────────────────────────────

  @EventPattern('instant-connect.request')
  async handleInstantConnectRequest(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      actorName: string;
      actorAvatar: string | null;
      readerUserId: string;
      sessionDurationMinutes: number;
      priceCents: number;
      currency: string;
      expiresAt: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Instant connect request: ${payload.actorUserId} → reader ${payload.readerUserId}`,
    );
    try {
      this.notificationsGateway.emitToUser(
        payload.readerUserId,
        'instant-connect.request',
        payload,
      );

      // Email fallback — reader may not have the app open
      const amountDollars = (payload.priceCents / 100).toFixed(2);
      const currency = (payload.currency || 'usd').toUpperCase();
      try {
        await this.notificationsService.send({
          recipientUserId: payload.readerUserId,
          title: 'An actor wants to read with you now',
          body: `${payload.actorName} wants to start a ${payload.sessionDurationMinutes}-minute session with you.`,
          channels: ['email'],
          template: 'instant-connect-request',
          data: {
            actorName: payload.actorName,
            sessionDurationMinutes: payload.sessionDurationMinutes,
            amountDollars,
            currency,
          },
        });
      } catch (emailError) {
        this.logger.error(
          `Failed to send instant-connect request email: ${emailError.message}`,
        );
      }

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to forward instant-connect.request: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('instant-connect.accepted')
  async handleInstantConnectAccepted(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      readerName: string | null;
      readerAvatar: string | null;
      sessionDurationMinutes: number;
      priceCents: number;
      currency: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Instant connect accepted: booking ${payload.bookingId}`);
    try {
      this.notificationsGateway.emitToUser(
        payload.actorUserId,
        'instant-connect.accepted',
        payload,
      );
      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to forward instant-connect.accepted: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('instant-connect.declined')
  async handleInstantConnectDeclined(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      reason?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Instant connect declined: booking ${payload.bookingId}`);
    try {
      this.notificationsGateway.emitToUser(
        payload.actorUserId,
        'instant-connect.declined',
        payload,
      );
      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to forward instant-connect.declined: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('instant-connect.timeout')
  async handleInstantConnectTimeout(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Instant connect timeout: booking ${payload.bookingId}`);
    try {
      this.notificationsGateway.emitToUser(
        payload.actorUserId,
        'instant-connect.timeout',
        payload,
      );
      this.notificationsGateway.emitToUser(
        payload.readerUserId,
        'instant-connect.timeout',
        payload,
      );
      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to forward instant-connect.timeout: ${error.message}`,
      );
      throw error;
    }
  }

  // ── Session Extension Events ────────────────────────────────────────────

  @EventPattern('session.extension_requested')
  async handleExtensionRequested(
    @Payload()
    payload: {
      extensionId: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      durationMinutes: number;
      priceCents: number;
      platformFeeCents: number;
      readerReceivesCents: number;
      extensionNumber: number;
      expiresAt: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Extension requested: booking ${payload.bookingId}, ${payload.durationMinutes}min`,
    );
    try {
      // WebSocket only — time-critical, reader must respond within 60s
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.extension_requested',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.extension_requested: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.extension_approved')
  async handleExtensionApproved(
    @Payload()
    payload: {
      extensionId: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      durationMinutes: number;
      priceCents: number;
      clientSecret: string;
      paymentWindowSeconds: number;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Extension approved: booking ${payload.bookingId}, awaiting payment`,
    );
    try {
      // WebSocket only — actor needs to pay immediately
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.extension_approved',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.extension_approved: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.extension_declined')
  async handleExtensionDeclined(
    @Payload()
    payload: {
      extensionId: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      reason?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Extension declined: booking ${payload.bookingId}`);
    try {
      // WebSocket only — inform actor in real-time
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.extension_declined',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.extension_declined: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.extension_activated')
  async handleExtensionActivated(
    @Payload()
    payload: {
      extensionId: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      extensionDurationMinutes: number;
      extensionPriceCents: number;
      platformFeeCents: number;
      newSessionEndUtc: string;
      previousSessionEndUtc: string;
      extensionNumber: number;
      currency: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Extension activated: booking ${payload.bookingId}, +${payload.extensionDurationMinutes}min`,
    );
    try {
      // WebSocket — both parties see updated session end time
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.extension_activated',
        payload,
      );

      // Email — receipt/confirmation to both parties
      const amountDollars = (payload.extensionPriceCents / 100).toFixed(2);
      const currency = (payload.currency || 'usd').toUpperCase();

      const emailData = {
        extensionDurationMinutes: payload.extensionDurationMinutes,
        newSessionEndUtc: payload.newSessionEndUtc,
        amountDollars,
        currency,
        extensionNumber: payload.extensionNumber,
      };

      for (const userId of [payload.actorUserId, payload.readerUserId]) {
        try {
          await this.notificationsService.send({
            recipientUserId: userId,
            title: `Session extended by ${payload.extensionDurationMinutes} minutes`,
            body: `Your session has been extended. New end time: ${payload.newSessionEndUtc} UTC.`,
            channels: ['email'],
            template: 'session-extension-activated',
            data: emailData,
          });
        } catch (emailError) {
          this.logger.error(
            `Failed to send extension activated email to ${userId}: ${emailError.message}`,
          );
        }
      }

      // In-app notification
      for (const userId of [payload.actorUserId, payload.readerUserId]) {
        try {
          await this.notificationRepository.createNotification({
            recipientUserId: userId,
            notificationType: NotificationType.SESSION_EXTENSION,
            title: `Session extended by ${payload.extensionDurationMinutes} minutes`,
            body: `Your reading session has been extended. New end time: ${payload.newSessionEndUtc} UTC. Amount: $${amountDollars} ${currency}.`,
            read: false,
          });
        } catch (notifError) {
          this.logger.error(
            `Failed to create extension activated notification for ${userId}: ${notifError.message}`,
          );
        }
      }

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.extension_activated: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.extension_expired')
  async handleExtensionExpired(
    @Payload()
    payload: {
      extensionId: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      reason: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Extension expired: booking ${payload.bookingId}, reason: ${payload.reason}`,
    );
    try {
      // WebSocket only — inform both parties in real-time
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.extension_expired',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.extension_expired: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.extension_failed')
  async handleExtensionFailed(
    @Payload()
    payload: {
      extensionId: string;
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      extensionDurationMinutes: number;
      extensionPriceCents: number;
      previousSessionEndUtc: string;
      currency: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Extension payment failed: booking ${payload.bookingId}`);
    try {
      // WebSocket — inform both parties
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.extension_failed',
        payload,
      );

      // Email — payment failure notice to actor
      const amountDollars = (payload.extensionPriceCents / 100).toFixed(2);
      const currency = (payload.currency || 'usd').toUpperCase();

      try {
        await this.notificationsService.send({
          recipientUserId: payload.actorUserId,
          title: 'Session extension payment failed',
          body: `Payment for your ${payload.extensionDurationMinutes}-minute extension could not be processed.`,
          channels: ['email'],
          template: 'session-extension-failed',
          data: {
            extensionDurationMinutes: payload.extensionDurationMinutes,
            amountDollars,
            currency,
            previousSessionEndUtc: payload.previousSessionEndUtc,
          },
        });
      } catch (emailError) {
        this.logger.error(
          `Failed to send extension failed email to actor: ${emailError.message}`,
        );
      }

      // In-app notification for actor
      try {
        await this.notificationRepository.createNotification({
          recipientUserId: payload.actorUserId,
          notificationType: NotificationType.SESSION_EXTENSION,
          title: 'Session extension payment failed',
          body: `Payment for your ${payload.extensionDurationMinutes}-minute session extension could not be processed. Your session was not extended.`,
          read: false,
        });
      } catch (notifError) {
        this.logger.error(
          `Failed to create extension failed notification: ${notifError.message}`,
        );
      }

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.extension_failed: ${error.message}`,
      );
      throw error;
    }
  }

  // ── Session Lifecycle Events ────────────────────────────────────────────

  @EventPattern('session.channel_ready')
  async handleSessionChannelReady(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      sessionStartUtc: string;
      sessionDurationMinutes: number;
      channelName: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Session channel ready: booking ${payload.bookingId}, starts at ${payload.sessionStartUtc}`,
    );
    try {
      // Send reminder email to both participants
      const minutesUntil = Math.round(
        (new Date(payload.sessionStartUtc).getTime() - Date.now()) / 60000,
      );

      const emailData = {
        sessionStartUtc: payload.sessionStartUtc,
        sessionDurationMinutes: payload.sessionDurationMinutes,
        minutesUntil: minutesUntil > 0 ? minutesUntil : 1,
      };

      const recipients = [
        { userId: payload.actorUserId, role: 'Actor' },
        { userId: payload.readerUserId, role: 'Reader' },
      ];

      for (const { userId, role } of recipients) {
        try {
          await this.notificationsService.send({
            recipientUserId: userId,
            title: `Your session starts in ${emailData.minutesUntil} minutes`,
            body: `Your reading session is starting soon. Get ready to join.`,
            channels: ['email'],
            template: 'session-reminder',
            data: { ...emailData, role },
          });
        } catch (emailError) {
          this.logger.error(
            `Failed to send session reminder email to ${userId}: ${emailError.message}`,
          );
        }
      }

      // WebSocket notification
      this.notificationsGateway.emitToUser(
        payload.actorUserId,
        'session.channel_ready',
        payload,
      );
      this.notificationsGateway.emitToUser(
        payload.readerUserId,
        'session.channel_ready',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.channel_ready: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.ending_soon')
  async handleSessionEndingSoon(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      sessionEndUtc: string;
      minutesRemaining: number;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Session ending soon: booking ${payload.bookingId}, ${payload.minutesRemaining}min left`,
    );
    try {
      // WebSocket only — both parties are already in-session
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.ending_soon',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle session.ending_soon: ${error.message}`,
      );
      throw error;
    }
  }

  @EventPattern('session.completed')
  async handleSessionCompleted(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      completedBy: string;
      completedAt: string;
      channelName?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Session completed: booking ${payload.bookingId}`);
    try {
      // WebSocket — real-time notification
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        'session.completed',
        payload,
      );

      // Clean up ephemeral chat messages
      await this.sessionChatService
        .deleteSessionMessages(payload.bookingId)
        .catch((e) =>
          this.logger.error(
            `Failed to clean up chat messages for ${payload.bookingId}: ${e.message}`,
          ),
        );
      this.teleprompterGateway.cleanupSession(payload.bookingId);

      // Email + in-app to both parties
      const recipients = [
        { userId: payload.actorUserId, role: 'Actor' },
        { userId: payload.readerUserId, role: 'Reader' },
      ];

      for (const { userId, role } of recipients) {
        try {
          await this.notificationsService.send({
            recipientUserId: userId,
            title: 'Your CueActor session is complete',
            body: `Your reading session has been completed.`,
            channels: ['email'],
            template: 'session-completed',
            data: {
              completedAt: payload.completedAt,
              role,
            },
          });
        } catch (emailError) {
          this.logger.error(
            `Failed to send session completed email to ${userId}: ${emailError.message}`,
          );
        }

        try {
          await this.notificationRepository.createNotification({
            recipientUserId: userId,
            notificationType: NotificationType.GENERAL,
            title: 'Session completed',
            body: `Your reading session has been completed.`,
            read: false,
          });
        } catch (notifError) {
          this.logger.error(
            `Failed to create session completed notification for ${userId}: ${notifError.message}`,
          );
        }
      }

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(`Failed to handle session.completed: ${error.message}`);
      throw error;
    }
  }

  @EventPattern('session.timeout')
  async handleSessionTimeout(
    @Payload()
    payload: {
      bookingId: string;
      actorUserId: string;
      readerUserId: string;
      reason: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`Session timeout: booking ${payload.bookingId}`);
    try {
      this.notificationsGateway.emitToUser(
        payload.actorUserId,
        'session.timeout',
        payload,
      );
      this.notificationsGateway.emitToUser(
        payload.readerUserId,
        'session.timeout',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(`Failed to handle session.timeout: ${error.message}`);
      throw error;
    }
  }

  // ── Payment Events ──────────────────────────────────────────────────────

  @EventPattern('payment.received')
  async handlePaymentReceived(
    @Payload()
    payload: {
      readerUserId: string;
      bookingId: string;
      amountCents: number;
      platformFeeCents: number;
      earningsCents: number;
      currency: string;
      sessionDurationMinutes: number;
      paymentType: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Payment received for reader ${payload.readerUserId}: $${(payload.earningsCents / 100).toFixed(2)}`,
    );
    try {
      const currency = (payload.currency || 'usd').toUpperCase();
      const amountDollars = (payload.amountCents / 100).toFixed(2);
      const platformFeeDollars = (payload.platformFeeCents / 100).toFixed(2);
      const earningsDollars = (payload.earningsCents / 100).toFixed(2);

      // Email to reader
      try {
        await this.notificationsService.send({
          recipientUserId: payload.readerUserId,
          title: `You received a payment of $${earningsDollars} ${currency}`,
          body: `Payment of $${earningsDollars} ${currency} received for a ${payload.sessionDurationMinutes}-minute session.`,
          channels: ['email'],
          template: 'payment-received',
          data: {
            amountDollars,
            platformFeeDollars,
            earningsDollars,
            currency,
            sessionDurationMinutes: payload.sessionDurationMinutes,
            paymentType: payload.paymentType,
          },
        });
      } catch (emailError) {
        this.logger.error(
          `Failed to send payment received email: ${emailError.message}`,
        );
      }

      // In-app notification
      try {
        await this.notificationRepository.createNotification({
          recipientUserId: payload.readerUserId,
          notificationType: NotificationType.PAYMENT,
          title: `Payment received: $${earningsDollars} ${currency}`,
          body: `You earned $${earningsDollars} ${currency} for a ${payload.sessionDurationMinutes}-minute session.`,
          read: false,
        });
      } catch (notifError) {
        this.logger.error(
          `Failed to create payment received notification: ${notifError.message}`,
        );
      }

      // WebSocket
      this.notificationsGateway.emitToUser(
        payload.readerUserId,
        'payment.received',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(`Failed to handle payment.received: ${error.message}`);
      throw error;
    }
  }

  // ── User Events ─────────────────────────────────────────────────────────

  @EventPattern('user.registered')
  async handleUserRegistered(
    @Payload()
    payload: {
      userId: string;
      email: string;
      fullName?: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(`New user registered: ${payload.userId}`);
    try {
      await this.notificationsService.send({
        recipientUserId: payload.userId,
        title: 'Welcome to CueActor',
        body: 'Welcome to ActorsCanRead — your platform for script reading and rehearsal.',
        channels: ['email'],
        template: 'welcome',
        data: {},
      });

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(`Failed to handle user.registered: ${error.message}`);
      throw error;
    }
  }

  // ── Recording Events ────────────────────────────────────────────────────

  @EventPattern('recording.ready')
  async handleRecordingReady(
    @Payload()
    payload: {
      userId: string;
      recordingId: string;
      sessionDate: string;
      durationSeconds?: number;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Recording ready: ${payload.recordingId} for user ${payload.userId}`,
    );
    try {
      // Email
      try {
        await this.notificationsService.send({
          recipientUserId: payload.userId,
          title: 'Your session recording is ready',
          body: 'Your recording has been processed and is ready to view.',
          channels: ['email'],
          template: 'recording-ready',
          data: {
            sessionDate: payload.sessionDate,
            durationSeconds: payload.durationSeconds || null,
          },
        });
      } catch (emailError) {
        this.logger.error(
          `Failed to send recording ready email: ${emailError.message}`,
        );
      }

      // In-app notification
      try {
        await this.notificationRepository.createNotification({
          recipientUserId: payload.userId,
          notificationType: NotificationType.RECORDING,
          title: 'Your session recording is ready',
          body: 'Your recording has been processed and is ready to view in your project dashboard.',
          read: false,
        });
      } catch (notifError) {
        this.logger.error(
          `Failed to create recording ready notification: ${notifError.message}`,
        );
      }

      // WebSocket
      this.notificationsGateway.emitToUser(
        payload.userId,
        'recording.ready',
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(`Failed to handle recording.ready: ${error.message}`);
      throw error;
    }
  }

  @EventPattern(HAZEL_RECORDING_EVENTS.FAILED)
  async handleHazelRecordingFailed(
    @Payload()
    payload: {
      rehearsalId: string | null;
      userId: string;
      stage: 'start' | 'stop' | 'finalize';
      reason: string;
      failedAt: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.warn(
      `Hazel recording failed: rehearsal=${payload.rehearsalId} user=${payload.userId} stage=${payload.stage} reason=${payload.reason}`,
    );

    try {
      // in-app notification — actor must know the rehearsal was not captured
      try {
        await this.notificationRepository.createNotification({
          recipientUserId: payload.userId,
          notificationType: NotificationType.RECORDING,
          title: 'Rehearsal recording failed',
          body: `Your rehearsal session could not be recorded (${payload.reason}). The rehearsal itself was unaffected.`,
          read: false,
        });
      } catch (notifError) {
        this.logger.error(
          `Failed to create hazel.recording.failed notification: ${notifError.message}`,
        );
      }

      this.notificationsGateway.emitToUser(
        payload.userId,
        HAZEL_RECORDING_EVENTS.FAILED,
        payload,
      );

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle hazel.recording.failed: ${error.message}`,
      );
      throw error;
    }
  }

  // ── Subscription Events (placeholder) ───────────────────────────────────

  @EventPattern('subscription.changed')
  async handleSubscriptionChanged(
    @Payload()
    payload: {
      userId: string;
      changeType: string; // 'upgraded' | 'downgraded' | 'renewed' | 'cancelled' | 'trial_ending'
      planName?: string;
      // TODO: finalize payload once subscription system is complete
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Subscription changed: user ${payload.userId}, type ${payload.changeType}`,
    );
    try {
      // TODO: implement full subscription notification logic once subscription system is finalized
      try {
        await this.notificationsService.send({
          recipientUserId: payload.userId,
          title: 'Your subscription has been updated',
          body: `Your CueActor subscription has been ${payload.changeType}.`,
          channels: ['email'],
          template: 'subscription-change',
          data: {
            changeType: payload.changeType,
            planName: payload.planName || null,
          },
        });
      } catch (emailError) {
        this.logger.error(
          `Failed to send subscription change email: ${emailError.message}`,
        );
      }

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to handle subscription.changed: ${error.message}`,
      );
      throw error;
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private async handleBookingCancelled(payload: {
    bookingId: string;
    actorUserId: string;
    readerUserId: string;
    sessionStartUtc: string;
    sessionEndUtc: string;
    sessionDurationMinutes: number;
    priceCents: number;
    currency: string;
    cancellationReason?: string;
    cancelledBy?: string;
  }): Promise<void> {
    const sessionDate = new Date(payload.sessionStartUtc).toLocaleString(
      'en-US',
      { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' },
    );
    const cancelledByRole =
      payload.cancelledBy === payload.actorUserId ? 'actor' : 'reader';

    const recipients = [
      { userId: payload.actorUserId, role: 'Actor' },
      { userId: payload.readerUserId, role: 'Reader' },
    ];

    for (const { userId, role } of recipients) {
      const isActor = role === 'Actor';
      const refundMessage = isActor
        ? 'If you were charged, a refund will be processed automatically.'
        : null;

      try {
        await this.notificationsService.send({
          recipientUserId: userId,
          title: 'Your CueActor session has been cancelled',
          body: `Your session scheduled for ${sessionDate} UTC has been cancelled.`,
          channels: ['email'],
          template: 'booking-cancelled',
          data: {
            sessionDate,
            sessionDurationMinutes: payload.sessionDurationMinutes,
            cancelledByRole,
            cancellationReason: payload.cancellationReason || null,
            refundMessage,
          },
        });
      } catch (emailError) {
        this.logger.error(
          `Failed to send booking cancelled email to ${userId}: ${emailError.message}`,
        );
      }

      try {
        await this.notificationRepository.createNotification({
          recipientUserId: userId,
          notificationType: NotificationType.GENERAL,
          title: 'Session cancelled',
          body: `Your session scheduled for ${sessionDate} UTC has been cancelled by the ${cancelledByRole}.`,
          read: false,
        });
      } catch (notifError) {
        this.logger.error(
          `Failed to create booking cancelled notification for ${userId}: ${notifError.message}`,
        );
      }
    }

    // WebSocket notification
    this.notificationsGateway.emitToUser(
      payload.actorUserId,
      'booking.cancelled',
      payload,
    );
    this.notificationsGateway.emitToUser(
      payload.readerUserId,
      'booking.cancelled',
      payload,
    );
  }

  // ── Feedback Events ────────────────────────────────────────────────────

  @EventPattern('feedback.request')
  async handleFeedbackRequest(
    @Payload()
    payload: {
      role: 'actor' | 'reader';
      recipientUserId: string;
      bookingId: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received feedback.request for ${payload.role} user ${payload.recipientUserId}`,
    );
    try {
      const reviewTarget = payload.role === 'actor' ? 'reader' : 'actor';
      const title = 'How was your session?';
      const body = `Your session is complete. Leave a review for your ${reviewTarget} to help others on CueActor.`;

      await this.notificationRepository.createNotification({
        recipientUserId: payload.recipientUserId,
        notificationType: NotificationType.FEEDBACK_REQUEST,
        title,
        body,
        read: false,
        metadata: { bookingId: payload.bookingId, role: payload.role },
      });

      await this.notificationsService.send({
        recipientUserId: payload.recipientUserId,
        title,
        body,
        channels: ['email'],
        data: {
          bookingId: payload.bookingId,
          role: payload.role,
          reviewTarget,
        },
      });

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to process feedback.request: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @EventPattern('feedback.reminder')
  async handleFeedbackReminder(
    @Payload()
    payload: {
      role: 'actor' | 'reader';
      recipientUserId: string;
      bookingId: string;
    },
    @Ctx() context: RmqContext,
  ) {
    this.logger.log(
      `Received feedback.reminder for ${payload.role} user ${payload.recipientUserId}`,
    );
    try {
      const reviewTarget = payload.role === 'actor' ? 'reader' : 'actor';
      const title = 'Reminder: share your session feedback';
      const body = `Don't forget to leave a review for your ${reviewTarget}. Your feedback helps the CueActor community.`;

      await this.notificationRepository.createNotification({
        recipientUserId: payload.recipientUserId,
        notificationType: NotificationType.FEEDBACK_REMINDER,
        title,
        body,
        read: false,
        metadata: { bookingId: payload.bookingId, role: payload.role },
      });

      await this.notificationsService.send({
        recipientUserId: payload.recipientUserId,
        title,
        body,
        channels: ['email'],
        data: {
          bookingId: payload.bookingId,
          role: payload.role,
          reviewTarget,
        },
      });

      const channel = context.getChannelRef();
      channel.ack(context.getMessage());
    } catch (error) {
      this.logger.error(
        `Failed to process feedback.reminder: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ── Session shared files ────────────────────────────────────────────────
  // Core emits these whenever a participant attaches/deletes/analyzes a file
  // mid-call. The /session Socket.io room is keyed by bookingId, so we just
  // forward the payload verbatim to the room. FE refetches the list endpoint
  // on receipt (events deliberately carry minimal state — list is the truth).

  @EventPattern(SESSION_FILE_EVENTS.SHARED)
  async handleSessionFileShared(
    @Payload() payload: SessionFileSharedEvent,
    @Ctx() context: RmqContext,
  ) {
    try {
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        SESSION_FILE_SOCKET_EVENTS.SHARED,
        payload,
      );
      context.getChannelRef().ack(context.getMessage());
    } catch (error: any) {
      this.logger.error(
        `Failed to fan out ${SESSION_FILE_SOCKET_EVENTS.SHARED}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @EventPattern(SESSION_FILE_EVENTS.ANALYZING)
  async handleSessionFileAnalyzing(
    @Payload() payload: SessionFileAnalyzingEvent,
    @Ctx() context: RmqContext,
  ) {
    try {
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        SESSION_FILE_SOCKET_EVENTS.ANALYZING,
        payload,
      );
      context.getChannelRef().ack(context.getMessage());
    } catch (error: any) {
      this.logger.error(
        `Failed to fan out ${SESSION_FILE_SOCKET_EVENTS.ANALYZING}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @EventPattern(SESSION_FILE_EVENTS.ANALYZED)
  async handleSessionFileAnalyzed(
    @Payload() payload: SessionFileAnalyzedEvent,
    @Ctx() context: RmqContext,
  ) {
    try {
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        SESSION_FILE_SOCKET_EVENTS.ANALYZED,
        payload,
      );
      context.getChannelRef().ack(context.getMessage());
    } catch (error: any) {
      this.logger.error(
        `Failed to fan out ${SESSION_FILE_SOCKET_EVENTS.ANALYZED}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  @EventPattern(SESSION_FILE_EVENTS.DELETED)
  async handleSessionFileDeleted(
    @Payload() payload: SessionFileDeletedEvent,
    @Ctx() context: RmqContext,
  ) {
    try {
      this.teleprompterGateway.emitToSession(
        payload.bookingId,
        SESSION_FILE_SOCKET_EVENTS.DELETED,
        payload,
      );
      context.getChannelRef().ack(context.getMessage());
    } catch (error: any) {
      this.logger.error(
        `Failed to fan out ${SESSION_FILE_SOCKET_EVENTS.DELETED}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}
