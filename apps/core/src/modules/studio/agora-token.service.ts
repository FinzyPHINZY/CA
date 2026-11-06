/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RtcTokenBuilder, RtcRole, RtmTokenBuilder } from 'agora-token';

// default token expiry: 1 hour
const DEFAULT_TOKEN_EXPIRE_SECONDS = 3600;
// privilege expiry: session duration + 10 min buffer
const DEFAULT_PRIVILEGE_EXPIRE_SECONDS = 3600 + 600;

export interface RtcTokenResult {
  token: string;
  uid: number;
  channelName: string;
  appId: string;
  expiresIn: number;
}

export interface RtmTokenResult {
  token: string;
  userId: string;
  appId: string;
  expiresIn: number;
}

@Injectable()
export class AgoraTokenService {
  private readonly logger = new Logger(AgoraTokenService.name);
  private readonly appId: string;
  private readonly appCertificate: string;

  constructor(private readonly configService: ConfigService) {
    this.appId = this.configService.get<string>('AGORA_APP_ID') || '';
    this.appCertificate =
      this.configService.get<string>('AGORA_APP_CERTIFICATE') || '';
  }

  getAppId(): string {
    return this.appId;
  }

  // generate an RTC token for joining a channel.
  // role: 'publisher' can send audio/video, 'subscriber' can only receive.
  generateRtcToken(
    channelName: string,
    uid: number,
    role: 'publisher' | 'subscriber',
    privilegeExpireSeconds?: number,
  ): RtcTokenResult {
    const agoraRole =
      role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const tokenExpire = DEFAULT_TOKEN_EXPIRE_SECONDS;
    const privilegeExpire =
      privilegeExpireSeconds ?? DEFAULT_PRIVILEGE_EXPIRE_SECONDS;

    const token = RtcTokenBuilder.buildTokenWithUid(
      this.appId,
      this.appCertificate,
      channelName,
      uid,
      agoraRole,
      tokenExpire,
      privilegeExpire,
    );

    this.logger.log(
      `RTC token generated for channel "${channelName}", uid ${uid}, role ${role}`,
    );

    return {
      token,
      uid,
      channelName,
      appId: this.appId,
      expiresIn: tokenExpire,
    };
  }

  // generate an RTM token for real-time messaging (used by signaling/notifications within sessions).
  generateRtmToken(userId: string, expireSeconds?: number): RtmTokenResult {
    const expire = expireSeconds ?? DEFAULT_TOKEN_EXPIRE_SECONDS;

    const token = RtmTokenBuilder.buildToken(
      this.appId,
      this.appCertificate,
      userId,
      expire,
    );

    this.logger.log(`RTM token generated for user "${userId}"`);

    return {
      token,
      userId,
      appId: this.appId,
      expiresIn: expire,
    };
  }
}
