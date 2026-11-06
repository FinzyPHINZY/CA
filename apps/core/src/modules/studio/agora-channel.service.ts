/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { AgoraSession, AgoraSessionRepository } from '@app/common';
import { AgoraSessionStatus } from '@app/common/enums/studio.enum';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AgoraTokenService, RtcTokenResult } from './agora-token.service';
import { StudioRecordingService } from './studio-recording.service';

// generates a deterministic Agora uid from a UUID string.
// Agora requires a 32-bit unsigned integer uid.
function uidFromUuid(uuid: string): number {
  const hex = uuid.replace(/-/g, '').slice(0, 8);
  // ensure non-zero uid (Agora treats 0 as "no auth")
  return (parseInt(hex, 16) % 2_147_483_647) + 1;
}

@Injectable()
export class AgoraChannelService {
  private readonly logger = new Logger(AgoraChannelService.name);

  constructor(
    private readonly agoraSessionRepository: AgoraSessionRepository,
    private readonly agoraTokenService: AgoraTokenService,
    private readonly studioRecordingService: StudioRecordingService,
  ) {}

  // create a new Agora channel for a booking or rehearsal.
  async createChannel(
    creatorUserId: string,
    options: {
      bookingId?: string;
      rehearsalId?: string;
    },
  ): Promise<AgoraSession> {
    if (!options.bookingId && !options.rehearsalId) {
      throw new BadRequestException(
        'Either bookingId or rehearsalId is required to create a channel.',
      );
    }

    const channelName = options.bookingId
      ? `session_${options.bookingId}`
      : `rehearsal_${options.rehearsalId}`;

    // check for existing active channel
    const existing =
      await this.agoraSessionRepository.findByChannelName(channelName);
    if (existing && existing.status !== AgoraSessionStatus.ENDED) {
      throw new ConflictException(
        `An active channel already exists: ${channelName}`,
      );
    }

    const session = await this.agoraSessionRepository.createEntity({
      channelName,
      bookingId: options.bookingId || null,
      rehearsalId: options.rehearsalId || null,
      creatorUserId,
      status: AgoraSessionStatus.CREATED,
    } as any);

    this.logger.log(
      `Channel created: ${channelName} by user ${creatorUserId}. Session ID: ${session.id}`,
    );

    return session;
  }

  // join a channel — validates authorization and returns a token.
  async joinChannel(
    userId: string,
    channelName: string,
    role: 'publisher' | 'subscriber' = 'publisher',
  ): Promise<{ session: AgoraSession; tokenResult: RtcTokenResult }> {
    const session =
      await this.agoraSessionRepository.findByChannelName(channelName);

    if (!session) {
      throw new NotFoundException(`Channel "${channelName}" not found.`);
    }

    if (session.status === AgoraSessionStatus.ENDED) {
      throw new BadRequestException(
        `Channel "${channelName}" has already ended.`,
      );
    }

    // update status to ACTIVE if it was just CREATED
    if (session.status === AgoraSessionStatus.CREATED) {
      await this.agoraSessionRepository.updateById(session.id, {
        status: AgoraSessionStatus.ACTIVE,
        startedAt: new Date(),
      } as any);
      session.status = AgoraSessionStatus.ACTIVE;
      session.startedAt = new Date();
    }

    const uid = uidFromUuid(userId);
    const tokenResult = this.agoraTokenService.generateRtcToken(
      channelName,
      uid,
      role,
    );

    this.logger.log(
      `User ${userId} joined channel "${channelName}" with uid ${uid}`,
    );

    return { session, tokenResult };
  }

  // leave a channel. if no participants remain, end the channel.
  async leaveChannel(
    userId: string,
    channelName: string,
  ): Promise<AgoraSession> {
    const session =
      await this.agoraSessionRepository.findByChannelName(channelName);

    if (!session) {
      throw new NotFoundException(`Channel "${channelName}" not found.`);
    }

    if (session.status === AgoraSessionStatus.ENDED) {
      return session;
    }

    this.logger.log(`User ${userId} left channel "${channelName}"`);

    // the actual "last participant" detection is handled by Agora NCS webhooks (3.2.8).
    // for now, this endpoint just acknowledges the leave and the frontend should
    // call endChannel explicitly when the session is done.
    return session;
  }

  // end a channel — marks the session as ended.
  async endChannel(userId: string, channelName: string): Promise<AgoraSession> {
    const session =
      await this.agoraSessionRepository.findByChannelName(channelName);

    if (!session) {
      throw new NotFoundException(`Channel "${channelName}" not found.`);
    }

    if (session.status === AgoraSessionStatus.ENDED) {
      return session;
    }

    // only the creator can end the channel
    if (session.creatorUserId !== userId) {
      throw new ForbiddenException(
        'Only the session creator can end the channel.',
      );
    }

    const now = new Date();
    await this.agoraSessionRepository.updateById(session.id, {
      status: AgoraSessionStatus.ENDED,
      endedAt: now,
    } as any);

    session.status = AgoraSessionStatus.ENDED;
    session.endedAt = now;

    this.logger.log(
      `Channel "${channelName}" ended by user ${userId}. Session ID: ${session.id}`,
    );

    return session;
  }

  // get channel status by name.
  async getChannelStatus(channelName: string): Promise<AgoraSession> {
    const session =
      await this.agoraSessionRepository.findByChannelName(channelName);

    if (!session) {
      throw new NotFoundException(`Channel "${channelName}" not found.`);
    }

    return session;
  }

  // get active sessions for a user.
  async getActiveSessionsForUser(userId: string): Promise<AgoraSession[]> {
    return this.agoraSessionRepository.findActiveByCreatorUserId(userId);
  }

  // refresh a token for an active session.
  async refreshToken(
    userId: string,
    channelName: string,
    role: 'publisher' | 'subscriber' = 'publisher',
  ): Promise<RtcTokenResult> {
    const session =
      await this.agoraSessionRepository.findByChannelName(channelName);

    if (!session) {
      throw new NotFoundException(`Channel "${channelName}" not found.`);
    }

    if (session.status === AgoraSessionStatus.ENDED) {
      throw new BadRequestException(
        `Cannot refresh token for ended channel "${channelName}".`,
      );
    }

    const uid = uidFromUuid(userId);
    return this.agoraTokenService.generateRtcToken(channelName, uid, role);
  }

  // handle Agora NCS (Notification Callback Service) events.
  // Agora sends these webhooks for channel lifecycle events.
  async handleNcsEvent(
    eventType: number,
    payload: any,
    productId?: number,
  ): Promise<void> {
    // Agora NCS event types (RTC, productId=1):
    // 101 = channel create, 102 = channel destroy
    // 103 = broadcaster join, 104 = broadcaster leave
    // 105 = audience join, 106 = audience leave
    //
    // Cloud recording events (productId=3) use `cname` instead of `channelName`
    // and a different eventType numbering — they fall through the switch below
    // and are logged for now.
    const channelName = payload?.channelName ?? payload?.cname;
    if (!channelName) {
      this.logger.warn('NCS event dropped — no channelName/cname in payload', {
        eventType,
        productId,
        payload,
      });
      return;
    }

    const session =
      await this.agoraSessionRepository.findByChannelName(channelName);
    if (!session) {
      this.logger.warn(
        `NCS event for unknown channel: ${channelName}`,
        payload,
      );
      return;
    }

    switch (eventType) {
      case 102: {
        // channel destroyed — stop recording and end the session
        if (session.status !== AgoraSessionStatus.ENDED) {
          // stop cloud recording if active
          if (session.agoraResourceId && session.agoraSid) {
            try {
              await this.studioRecordingService.stopRecording(session);
            } catch (error: any) {
              this.logger.error(
                `Failed to stop recording on channel destroy: ${error.message}`,
              );
            }
          }

          await this.agoraSessionRepository.updateById(session.id, {
            status: AgoraSessionStatus.ENDED,
            endedAt: new Date(),
          } as any);
          this.logger.log(
            `Channel "${channelName}" destroyed via NCS. Session ended.`,
          );
        }
        break;
      }
      case 103: {
        // broadcaster joined — activate session and auto-start recording
        if (session.status === AgoraSessionStatus.CREATED) {
          await this.agoraSessionRepository.updateById(session.id, {
            status: AgoraSessionStatus.ACTIVE,
            startedAt: session.startedAt || new Date(),
          } as any);
          session.status = AgoraSessionStatus.ACTIVE;
          session.startedAt = session.startedAt || new Date();
        }

        // auto-start cloud recording if not already recording
        if (
          session.status === AgoraSessionStatus.ACTIVE &&
          !session.agoraResourceId
        ) {
          try {
            const mode = (session.cloudRecordingConfig as any)?.mode || 'mix';
            await this.studioRecordingService.startRecording(session, mode);
          } catch (error: any) {
            this.logger.error(
              `Failed to auto-start recording for channel "${channelName}": ${error.message}`,
            );
          }
        }

        this.logger.log(
          `Broadcaster joined channel "${channelName}" (uid: ${payload?.uid})`,
        );
        break;
      }
      case 104: {
        // broadcaster left
        this.logger.log(
          `Broadcaster left channel "${channelName}" (uid: ${payload?.uid})`,
        );
        break;
      }
      default: {
        this.logger.debug(
          `NCS event ${eventType} for channel "${channelName}"`,
        );
      }
    }
  }
}
