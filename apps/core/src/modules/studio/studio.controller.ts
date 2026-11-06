/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AgoraChannelService } from './agora-channel.service';
import { HazelNcsHandlerService } from '../recording/hazel-ncs-handler.service';
import { AgoraTokenService } from './agora-token.service';
import { ChatMessageDto } from './dto/chat-message.dto';
import { CreateChannelDto } from './dto/create-channel.dto';
import { GenerateTokenDto } from './dto/generate-token.dto';
import { JoinChannelDto } from './dto/join-channel.dto';
import { LeaveChannelDto } from './dto/leave-channel.dto';
import { NcsEventDto } from './dto/ncs-event.dto';
import {
  DeclineExtensionDto,
  RequestExtensionDto,
} from './dto/session-extension.dto';
import { CreateSoloSessionDto } from './dto/solo-session.dto';
import { StartRecordingDto } from './dto/start-recording.dto';
import { SessionService } from './session.service';
import { SessionChatService } from './session-chat.service';
import { SessionExtensionService } from './session-extension.service';
import { StudioRecordingService } from './studio-recording.service';

const sessionExample = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  channelName: 'session_123e4567-e89b-12d3-a456-426614174000',
  status: 'created',
  bookingId: '123e4567-e89b-12d3-a456-426614174000',
  rehearsalId: null,
  creatorUserId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
  agoraResourceId: null,
  agoraSid: null,
  startedAt: '2026-02-27T14:00:00.000Z',
  endedAt: null,
  createdAt: '2026-02-27T14:00:00.000Z',
  updatedAt: '2026-02-27T14:00:00.000Z',
};

const tokenExample = {
  token: '007eJwT...',
  uid: 1140709878,
  channelName: 'session_123e4567-e89b-12d3-a456-426614174000',
  appId: 'acec5a2d...',
  expiresIn: 3600,
};

const errorSchema = (
  statusCode: number,
  message: string | string[],
  error: string,
) => ({
  type: 'object',
  properties: {
    statusCode: { type: 'number', example: statusCode },
    message: Array.isArray(message)
      ? {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          example: message,
        }
      : { type: 'string', example: message },
    error: { type: 'string', example: error },
  },
});

@ApiTags('Studio')
@Controller('studio')
export class StudioController {
  private readonly logger = new Logger(StudioController.name);

  constructor(
    private readonly agoraChannelService: AgoraChannelService,
    private readonly studioRecordingService: StudioRecordingService,
    private readonly agoraTokenService: AgoraTokenService,
    private readonly sessionService: SessionService,
    private readonly sessionExtensionService: SessionExtensionService,
    private readonly sessionChatService: SessionChatService,
    private readonly hazelNcsHandler: HazelNcsHandlerService,
  ) {}

  // token endpoints
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Generate Agora RTC token',
    description:
      'Generates an RTC token for the authenticated user to join an existing Agora channel. Use this endpoint when a user needs to reconnect after a network drop. For the initial join, use POST /studio/channel/join which generates the token automatically.',
  })
  @ApiBody({ type: GenerateTokenDto })
  @ApiOkResponse({
    description: 'Token generated successfully',
    schema: {
      example: {
        success: true,
        message: 'Token generated successfully',
        data: tokenExample,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid request data',
    schema: errorSchema(400, 'Channel name is required', 'Bad Request'),
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async generateToken(
    @Req() req: any,
    @Body(ValidationPipe) dto: GenerateTokenDto,
  ) {
    const userId = req.user?.id;
    const tokenResult = await this.agoraChannelService.refreshToken(
      userId,
      dto.channelName,
      dto.role,
    );
    return {
      success: true,
      message: 'Token generated successfully',
      data: tokenResult,
    };
  }

  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Refresh Agora RTC token',
    description:
      "Refreshes an RTC token for an active session. Call this in response to the Agora SDK's `token-privilege-will-expire` event (fires at ~80% of token lifetime). Pass the new token to `client.renewToken(token)` — no disconnect needed.",
  })
  @ApiBody({ type: GenerateTokenDto })
  @ApiOkResponse({
    description: 'Token refreshed successfully',
    schema: {
      example: {
        success: true,
        message: 'Token refreshed successfully',
        data: tokenExample,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Channel has ended or invalid request',
    schema: errorSchema(400, 'Channel has already ended', 'Bad Request'),
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async refreshToken(
    @Req() req: any,
    @Body(ValidationPipe) dto: GenerateTokenDto,
  ) {
    const userId = req.user?.id;
    const tokenResult = await this.agoraChannelService.refreshToken(
      userId,
      dto.channelName,
      dto.role,
    );
    return {
      success: true,
      message: 'Token refreshed successfully',
      data: tokenResult,
    };
  }

  // channel management endpoints
  @Post('channel')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create an Agora channel',
    description:
      'Creates a new Agora channel associated with a booking or rehearsal. ' +
      'Provide exactly ONE of `bookingId` or `rehearsalId` — never both. ' +
      'Channel name is auto-generated: `session_{bookingId}` or `rehearsal_{rehearsalId}`. ' +
      'No Agora API call is made here — the channel becomes live when the first user joins.',
  })
  @ApiBody({
    type: CreateChannelDto,
    description:
      'Provide bookingId (for a paid reader session) OR rehearsalId (for a personal rehearsal). Never both.',
  })
  @ApiCreatedResponse({
    description: 'Channel created successfully',
    schema: {
      example: {
        success: true,
        message: 'Channel created successfully',
        data: sessionExample,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Neither bookingId nor rehearsalId provided, or booking not confirmed',
    schema: errorSchema(
      400,
      'Either bookingId or rehearsalId must be provided',
      'Bad Request',
    ),
  })
  @ApiConflictResponse({
    description: 'Active channel already exists for this booking/rehearsal',
    schema: errorSchema(
      409,
      'An active channel already exists for this booking',
      'Conflict',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async createChannel(
    @Req() req: any,
    @Body(ValidationPipe) dto: CreateChannelDto,
  ) {
    const userId = req.user?.id;
    const session = await this.agoraChannelService.createChannel(userId, {
      bookingId: dto.bookingId,
      rehearsalId: dto.rehearsalId,
    });
    return {
      success: true,
      message: 'Channel created successfully',
      data: session,
    };
  }

  @Post('channel/join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Join an Agora channel',
    description:
      'Join an existing Agora channel. Returns a token + Agora config to pass directly to the Agora SDK. ' +
      'Both actor and reader call this endpoint separately with their own auth token. ' +
      'The session status flips to `active` when the first user joins.',
  })
  @ApiBody({ type: JoinChannelDto })
  @ApiOkResponse({
    description: 'Joined channel successfully',
    schema: {
      example: {
        success: true,
        message: 'Channel joined successfully',
        data: {
          session: {
            ...sessionExample,
            status: 'active',
            startedAt: '2026-02-27T14:00:00.000Z',
          },
          tokenResult: tokenExample,
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Channel has already ended',
    schema: errorSchema(400, 'Channel has already ended', 'Bad Request'),
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async joinChannel(
    @Req() req: any,
    @Body(ValidationPipe) dto: JoinChannelDto,
  ) {
    const userId = req.user?.id;
    const result = await this.agoraChannelService.joinChannel(
      userId,
      dto.channelName,
      dto.role || 'publisher',
    );
    return {
      success: true,
      message: 'Channel joined successfully',
      data: result,
    };
  }

  @Post('channel/leave')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Leave an Agora channel',
    description:
      'Signal that the user is leaving the channel. Also call `client.leave()` on the Agora SDK. ' +
      'This does not end the session — other participants remain live. ' +
      'To end the session entirely, use POST /studio/channel/:channelName/end.',
  })
  @ApiBody({ type: LeaveChannelDto })
  @ApiOkResponse({
    description: 'Left channel successfully — returns updated session record',
    schema: {
      example: {
        success: true,
        message: 'Left channel successfully',
        data: sessionExample,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async leaveChannel(
    @Req() req: any,
    @Body(ValidationPipe) dto: LeaveChannelDto,
  ) {
    const userId = req.user?.id;
    const session = await this.agoraChannelService.leaveChannel(
      userId,
      dto.channelName,
    );
    return {
      success: true,
      message: 'Left channel successfully',
      data: session,
    };
  }

  @Post('channel/:channelName/end')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'End an Agora channel',
    description:
      'End the channel and mark the session as completed. Only the session creator (the user who called POST /studio/channel) can end it. ' +
      'If cloud recording is active, it stops automatically via the NCS webhook after Agora detects the channel is empty.',
  })
  @ApiParam({
    name: 'channelName',
    description: 'The Agora channel name',
    type: 'string',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Channel ended — session status is now `ended`',
    schema: {
      example: {
        success: true,
        message: 'Channel ended successfully',
        data: {
          ...sessionExample,
          status: 'ended',
          endedAt: '2026-02-27T15:00:00.000Z',
        },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Only the session creator can end the channel',
    schema: errorSchema(
      403,
      'Only the session creator can end this channel',
      'Forbidden',
    ),
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async endChannel(@Req() req: any, @Param('channelName') channelName: string) {
    const userId = req.user?.id;
    const session = await this.agoraChannelService.endChannel(
      userId,
      channelName,
    );
    return {
      success: true,
      message: 'Channel ended successfully',
      data: session,
    };
  }

  @Get('channel/:channelName/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get channel status',
    description:
      'Returns the current status and metadata for an Agora channel. Use this to poll for session state changes (e.g., checking if the other participant has joined).',
  })
  @ApiParam({
    name: 'channelName',
    description: 'The Agora channel name',
    type: 'string',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Channel status retrieved',
    schema: {
      example: {
        success: true,
        message: 'Channel status retrieved successfully',
        data: sessionExample,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async getChannelStatus(@Param('channelName') channelName: string) {
    const session =
      await this.agoraChannelService.getChannelStatus(channelName);
    return {
      success: true,
      message: 'Channel status retrieved successfully',
      data: session,
    };
  }

  @Get('sessions/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get active sessions for current user',
    description:
      'Returns all active (non-ended) Agora sessions created by the authenticated user.',
  })
  @ApiOkResponse({
    description: 'Active sessions retrieved',
    schema: {
      example: {
        success: true,
        message: 'Active sessions retrieved successfully',
        data: [sessionExample],
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async getMyActiveSessions(@Req() req: any) {
    const userId = req.user?.id;
    const sessions =
      await this.agoraChannelService.getActiveSessionsForUser(userId);
    return {
      success: true,
      message: 'Active sessions retrieved successfully',
      data: sessions,
    };
  }

  // cloud recording endpoints
  @Post('recording/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start cloud recording for a channel',
    description:
      'Manually start cloud recording for an active Agora channel. ' +
      'Under normal operation this is not needed — recording starts automatically via the NCS webhook when a broadcaster joins. ' +
      'Use `mode: "mix"` (default) for a single composite file, or `mode: "individual"` for separate per-participant tracks.',
  })
  @ApiBody({ type: StartRecordingDto })
  @ApiOkResponse({
    description:
      'Recording started — session updated with agoraResourceId and agoraSid',
    schema: {
      example: {
        success: true,
        message: 'Recording started successfully',
        data: {
          ...sessionExample,
          status: 'recording',
          agoraResourceId: 'resource_id',
          agoraSid: 'sid_value',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Channel not found or not active',
    schema: errorSchema(
      400,
      'Channel is not active or does not exist',
      'Bad Request',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async startRecording(@Body(ValidationPipe) dto: StartRecordingDto) {
    const session = await this.agoraChannelService.getChannelStatus(
      dto.channelName,
    );
    const updatedSession = await this.studioRecordingService.startRecording(
      session,
      dto.mode || 'mix',
    );
    return {
      success: true,
      message: 'Recording started successfully',
      data: updatedSession,
    };
  }

  @Post('recording/stop')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Stop cloud recording for a channel',
    description:
      'Manually stop cloud recording. Creates Recording and Media entities from the output files. ' +
      'Under normal operation this is not needed — recording stops automatically via the NCS webhook when the channel is destroyed.',
  })
  @ApiBody({ type: StartRecordingDto })
  @ApiOkResponse({
    description: 'Recording stopped',
    schema: {
      example: {
        success: true,
        message: 'Recording stopped successfully',
        data: { stopped: true },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Agora API rejected the stop request — resourceId/sid may be stale or expired',
    schema: errorSchema(400, 'Failed to stop cloud recording.', 'Bad Request'),
  })
  @ApiNotFoundResponse({
    description: 'No session found for the given channelName',
    schema: errorSchema(404, 'Channel "<channelName>" not found.', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async stopRecording(@Body(ValidationPipe) dto: StartRecordingDto) {
    const session = await this.agoraChannelService.getChannelStatus(
      dto.channelName,
    );
    await this.studioRecordingService.stopRecording(session);
    return {
      success: true,
      message: 'Recording stopped successfully',
      data: { stopped: true },
    };
  }

  @Get('recording/:channelName/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Query cloud recording status',
    description:
      'Returns the current status of an active cloud recording from the Agora Cloud Recording API.',
  })
  @ApiParam({
    name: 'channelName',
    description: 'The Agora channel name',
    type: 'string',
    example: 'session_123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description:
      'Recording status from Agora Cloud Recording API. Null data if no active recording.',
    schema: {
      example: {
        success: true,
        message: 'Recording status retrieved successfully',
        data: { status: 5, serverResponse: {} },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Channel not found',
    schema: errorSchema(
      404,
      'Channel session_123e4567-e89b-12d3-a456-426614174000 not found',
      'Not Found',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async queryRecordingStatus(@Param('channelName') channelName: string) {
    const session =
      await this.agoraChannelService.getChannelStatus(channelName);
    const status = await this.studioRecordingService.queryRecording(session);
    return {
      success: true,
      message: 'Recording status retrieved successfully',
      data: status,
    };
  }

  @Post('recording/solo')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Create a solo recording session',
    description:
      'Creates a single-user Agora channel for solo teleprompter recording. ' +
      'Returns the channel + token in one call. Actor joins, records, then stops. ' +
      'Optionally associate with an existing rehearsal via `rehearsalId`.',
  })
  @ApiBody({ type: CreateSoloSessionDto })
  @ApiCreatedResponse({
    description:
      'Solo session created — pass token to Agora SDK to start publishing',
    schema: {
      example: {
        success: true,
        message: 'Solo session created successfully',
        data: {
          session: sessionExample,
          token: '007eJwT...',
          uid: 1140709878,
          appId: 'acec5a2d...',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid request data',
    schema: errorSchema(
      400,
      ['Project ID is required', 'Script ID must be a valid UUID'],
      'Bad Request',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async createSoloSession(
    @Req() req: any,
    @Body(ValidationPipe) dto: CreateSoloSessionDto,
  ) {
    const userId = req.user?.id;
    const result = await this.studioRecordingService.createSoloSession(userId, {
      rehearsalId: dto.rehearsalId,
      projectId: dto.projectId,
      scriptId: dto.scriptId,
      sceneId: dto.sceneId,
    });

    // generate the token (StudioRecordingService can't do this without circular dep)
    const tokenResult = this.agoraTokenService.generateRtcToken(
      result.session.channelName,
      result.uid,
      'publisher',
    );

    return {
      success: true,
      message: 'Solo session created successfully',
      data: {
        session: result.session,
        token: tokenResult.token,
        uid: result.uid,
        appId: tokenResult.appId,
      },
    };
  }

  // reader session endpoints
  @Post('sessions/:bookingId/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start or join a reader session',
    description:
      'Called by either the actor or the reader to start/join a paid reader session. ' +
      'Creates the Agora channel if it does not exist yet (the bridge cron pre-creates it 15 min before, but this is the fallback). ' +
      'Returns a token + channel details to pass directly to the Agora SDK. ' +
      'Can be called up to 30 minutes before the scheduled session start.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the confirmed booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description:
      'Session started — join the Agora channel with the returned token',
    schema: {
      example: {
        success: true,
        message: 'Session started successfully',
        data: {
          booking: { id: '123e4567-...', status: 'in_progress' },
          session: sessionExample,
          tokenResult: tokenExample,
          role: 'actor',
          channelName: 'session_123e4567-e89b-12d3-a456-426614174000',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Session not yet open, time window passed, or invalid booking status',
    schema: errorSchema(
      400,
      'Session not open yet. Opens in 12 minute(s).',
      'Bad Request',
    ),
  })
  @ApiForbiddenResponse({
    description: 'User is not a participant in this booking',
    schema: errorSchema(
      403,
      'You are not a participant in this booking',
      'Forbidden',
    ),
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: errorSchema(404, 'Booking 123e4567-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async startReaderSession(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionService.startSession(bookingId, userId);
  }

  @Post('sessions/:bookingId/complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a reader session',
    description:
      'Mark a reader session as completed. Can be called by either participant. ' +
      'Stops cloud recording, ends the Agora channel, updates booking status to `completed`, ' +
      'and emits a WebSocket notification to both parties. Idempotent — safe to call multiple times.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the in-progress booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Session completed',
    schema: {
      example: {
        success: true,
        message: 'Session completed successfully',
        data: {
          booking: { id: '123e4567-...', status: 'completed' },
          completed: true,
        },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'User is not a participant in this booking',
    schema: errorSchema(
      403,
      'You are not a participant in this booking',
      'Forbidden',
    ),
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: errorSchema(404, 'Booking 123e4567-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async completeReaderSession(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionService.completeSession(bookingId, userId);
  }

  @Post('sessions/:bookingId/reconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get a fresh token after a network reconnect',
    description:
      'Generates a fresh Agora RTC token for a participant who has reconnected after a network drop. ' +
      'The session must still be in `in_progress` status. ' +
      'Pass the returned token to `client.join()` (or `client.renewToken()` if still in the channel).',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the in-progress booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Fresh token generated for reconnect',
    schema: {
      example: {
        success: true,
        message: 'Reconnected successfully',
        data: {
          tokenResult: tokenExample,
          channelName: 'session_123e4567-e89b-12d3-a456-426614174000',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Session is not active or no channel found',
    schema: errorSchema(
      400,
      'Session is not active (status: completed). Cannot reconnect.',
      'Bad Request',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async reconnectReaderSession(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionService.reconnectSession(bookingId, userId);
  }

  @Get('sessions/:bookingId/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get reader session status',
    description:
      'Returns the current booking state, Agora session (if exists), and computed time metadata. ' +
      'Use `isOpen` to determine whether the join window is open. ' +
      'Use `minutesUntilOpen` to show a countdown timer before the session window.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Session status returned',
    schema: {
      example: {
        success: true,
        message: 'Session status retrieved successfully',
        data: {
          booking: { id: '123e4567-...', status: 'confirmed' },
          session: sessionExample,
          isOpen: true,
          minutesUntilOpen: null,
          minutesRemaining: 45,
        },
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async getReaderSessionStatus(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionService.getSessionStatus(bookingId, userId);
  }

  // session chat

  @Get('sessions/:bookingId/chat/messages')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get session chat history',
    description:
      'Returns all chat messages for an active session. Messages are ephemeral — ' +
      'they exist only while the session is active and are deleted when the session completes. ' +
      'Use this endpoint when a client first joins or reconnects to catch up on missed messages. ' +
      'For real-time updates, listen for `chat.message` events on the `/session` WebSocket namespace. ' +
      'Returns an empty array if the session has ended or no messages have been sent.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the booking associated with the session',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description:
      'Chat messages retrieved successfully. Returns messages in chronological order (oldest first). ' +
      'Each message is either a text message (with `content` field) or a file message (with `fileUrl`, `fileName`, `fileSize`, `mimeType` fields).',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: {
          type: 'string',
          example: 'Chat messages retrieved successfully',
        },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                format: 'uuid',
                example: '550e8400-e29b-41d4-a716-446655440000',
                description: 'Server-generated unique message ID',
              },
              senderId: {
                type: 'string',
                format: 'uuid',
                example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
                description: 'User ID of the message sender',
              },
              senderName: {
                type: 'string',
                example: 'Jane Doe',
                description: 'Display name of the sender',
              },
              senderAvatar: {
                type: 'string',
                nullable: true,
                example: 'https://cdn.example.com/avatars/jane.jpg',
                description: 'Avatar URL of the sender (may be absent)',
              },
              type: {
                type: 'string',
                enum: ['text', 'file'],
                example: 'text',
                description:
                  'Message type — text for plain messages, file for shared files/images',
              },
              content: {
                type: 'string',
                nullable: true,
                example: 'Ready when you are!',
                description:
                  'Text content (present for text messages, max 2000 chars)',
              },
              fileUrl: {
                type: 'string',
                nullable: true,
                example:
                  'https://s3.amazonaws.com/bucket/media/session-chat/1704067260000-notes.pdf',
                description:
                  'S3 URL of the uploaded file (present for file messages)',
              },
              fileName: {
                type: 'string',
                nullable: true,
                example: 'notes.pdf',
                description: 'Original file name (present for file messages)',
              },
              fileSize: {
                type: 'number',
                nullable: true,
                example: 102400,
                description: 'File size in bytes (present for file messages)',
              },
              mimeType: {
                type: 'string',
                nullable: true,
                example: 'application/pdf',
                description:
                  'MIME type of the file (present for file messages)',
              },
              timestamp: {
                type: 'number',
                example: 1704067200000,
                description:
                  'Server-assigned timestamp in epoch milliseconds. Use for ordering and display.',
              },
            },
            required: ['id', 'senderId', 'senderName', 'type', 'timestamp'],
          },
          example: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              senderId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
              senderName: 'Jane Doe',
              senderAvatar: 'https://cdn.example.com/avatars/jane.jpg',
              type: 'text',
              content: 'Ready when you are!',
              timestamp: 1704067200000,
            },
            {
              id: '660f9511-f39c-52e5-b827-557766551111',
              senderId: '91ad3bec-c918-4b4d-91e8-945162309040',
              senderName: 'John Smith',
              type: 'file',
              fileUrl:
                'https://s3.amazonaws.com/bucket/media/session-chat/1704067260000-reference.png',
              fileName: 'reference.png',
              fileSize: 204800,
              mimeType: 'image/png',
              timestamp: 1704067260000,
            },
          ],
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid bookingId format',
    schema: errorSchema(
      400,
      'Validation failed (uuid is expected)',
      'Bad Request',
    ),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async getSessionChatMessages(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const messages = await this.sessionChatService.getMessages(bookingId);
    return {
      success: true,
      message: 'Chat messages retrieved successfully',
      data: messages,
    };
  }

  // session extension endpoints

  @Post('sessions/:bookingId/extend')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Request a session extension',
    description:
      'Actor requests to extend the current in-progress session by 15 or 30 minutes. ' +
      'The reader will be notified via WebSocket and must approve within 60 seconds. ' +
      'Max 3 extensions per session. Both actor (per-booking) and reader (profile-level) must have extensions enabled.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the in-progress booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiBody({ type: RequestExtensionDto })
  @ApiOkResponse({
    description: 'Extension request created and sent to reader for approval',
    schema: {
      example: {
        success: true,
        message: 'Extension request sent to reader',
        data: {
          extension: {
            id: '550e8400-e29b-41d4-a716-446655440000',
            bookingId: '123e4567-e89b-12d3-a456-426614174000',
            extensionDurationMinutes: 15,
            extensionPriceCents: 750,
            platformFeeCents: 113,
            status: 'requested',
            extensionNumber: 1,
            previousSessionEndUtc: '2026-03-27T15:00:00.000Z',
            newSessionEndUtc: '2026-03-27T15:15:00.000Z',
            requestedAt: '2026-03-27T14:50:00.000Z',
          },
          pricing: {
            durationMinutes: 15,
            priceCents: 750,
            platformFeeCents: 113,
            readerReceivesCents: 637,
            currency: 'USD',
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Session not in progress, extensions disabled, max reached, pending extension exists, or slot conflict',
    schema: errorSchema(400, 'Extension limit reached (3/3)', 'Bad Request'),
  })
  @ApiForbiddenResponse({
    description: 'Only the actor can request extensions',
    schema: errorSchema(
      403,
      'Only the actor can request a session extension',
      'Forbidden',
    ),
  })
  @ApiConflictResponse({
    description: 'Another extension request is already pending',
    schema: errorSchema(
      409,
      'An extension request is already pending for this booking',
      'Conflict',
    ),
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: errorSchema(404, 'Booking 123e4567-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async requestExtension(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
    @Body(ValidationPipe) dto: RequestExtensionDto,
  ) {
    const userId = req.user?.id;
    return this.sessionExtensionService.requestExtension(
      bookingId,
      userId,
      dto.durationMinutes,
    );
  }

  @Post('sessions/extensions/:extensionId/approve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Approve a session extension request',
    description:
      'Reader approves an extension request. Creates a Stripe PaymentIntent for the actor to confirm.',
  })
  @ApiParam({
    name: 'extensionId',
    description: 'UUID of the extension request',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description:
      'Extension approved — Stripe PaymentIntent created for actor to confirm',
    schema: {
      example: {
        success: true,
        message: 'Extension approved — awaiting payment',
        data: {
          extension: {
            id: '550e8400-e29b-41d4-a716-446655440000',
            status: 'payment_pending',
            approvedAt: '2026-03-27T14:50:30.000Z',
            stripePaymentIntentId: 'pi_3P...',
          },
          clientSecret: 'pi_3P..._secret_abc123',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Extension not in requested status or already expired',
    schema: errorSchema(
      400,
      'Extension is not in requested status (current: expired)',
      'Bad Request',
    ),
  })
  @ApiForbiddenResponse({
    description: 'Only the reader can approve extensions',
    schema: errorSchema(
      403,
      'Only the reader can approve this extension',
      'Forbidden',
    ),
  })
  @ApiNotFoundResponse({
    description: 'Extension not found',
    schema: errorSchema(404, 'Extension 550e8400-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async approveExtension(
    @Req() req: any,
    @Param('extensionId') extensionId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionExtensionService.approveExtension(extensionId, userId);
  }

  @Post('sessions/extensions/:extensionId/decline')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Decline a session extension request',
    description:
      'Reader declines an extension request with an optional reason.',
  })
  @ApiParam({
    name: 'extensionId',
    description: 'UUID of the extension request',
    type: 'string',
    format: 'uuid',
  })
  @ApiBody({ type: DeclineExtensionDto, required: false })
  @ApiOkResponse({
    description: 'Extension request declined',
    schema: {
      example: {
        success: true,
        message: 'Extension declined',
        data: {
          extension: {
            id: '550e8400-e29b-41d4-a716-446655440000',
            status: 'declined',
            declinedAt: '2026-03-27T14:50:45.000Z',
            declineReason: 'I have another session starting soon',
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Extension not in requested status',
    schema: errorSchema(
      400,
      'Extension is not in requested status (current: expired)',
      'Bad Request',
    ),
  })
  @ApiForbiddenResponse({
    description: 'Only the reader can decline extensions',
    schema: errorSchema(
      403,
      'Only the reader can decline this extension',
      'Forbidden',
    ),
  })
  @ApiNotFoundResponse({
    description: 'Extension not found',
    schema: errorSchema(404, 'Extension 550e8400-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async declineExtension(
    @Req() req: any,
    @Param('extensionId') extensionId: string,
    @Body(ValidationPipe) dto: DeclineExtensionDto,
  ) {
    const userId = req.user?.id;
    return this.sessionExtensionService.declineExtension(
      extensionId,
      userId,
      dto?.reason,
    );
  }

  @Get('sessions/:bookingId/extension-options')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get available extension options',
    description:
      'Returns available extension durations with pricing and availability status. ' +
      'Checks slot conflicts, extension count limits, and reader preferences.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Extension options with pricing and availability',
    schema: {
      example: {
        success: true,
        message: 'Extension options retrieved',
        data: {
          canExtend: true,
          extensionCount: 1,
          maxExtensions: 3,
          options: [
            {
              durationMinutes: 15,
              priceCents: 750,
              platformFeeCents: 113,
              readerReceivesCents: 637,
              available: true,
            },
            {
              durationMinutes: 30,
              priceCents: 1500,
              platformFeeCents: 225,
              readerReceivesCents: 1275,
              available: false,
              unavailableReason:
                'Reader has a conflicting booking in this time window',
            },
          ],
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: errorSchema(404, 'Booking 123e4567-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async getExtensionOptions(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionExtensionService.getExtensionOptions(bookingId, userId);
  }

  @Get('sessions/:bookingId/extensions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'List extension history for a booking',
    description:
      'Returns all extension requests (active, declined, expired, etc.) for a booking.',
  })
  @ApiParam({
    name: 'bookingId',
    description: 'UUID of the booking',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'All extension records for this booking',
    schema: {
      example: {
        success: true,
        message: 'Extension history retrieved',
        data: {
          extensions: [
            {
              id: '550e8400-e29b-41d4-a716-446655440000',
              extensionDurationMinutes: 15,
              extensionPriceCents: 750,
              status: 'active',
              extensionNumber: 1,
              requestedAt: '2026-03-27T14:50:00.000Z',
              approvedAt: '2026-03-27T14:50:30.000Z',
              activatedAt: '2026-03-27T14:50:45.000Z',
            },
            {
              id: '660e8400-e29b-41d4-a716-446655440001',
              extensionDurationMinutes: 30,
              extensionPriceCents: 1500,
              status: 'declined',
              extensionNumber: 2,
              requestedAt: '2026-03-27T15:10:00.000Z',
              declinedAt: '2026-03-27T15:10:20.000Z',
              declineReason: 'I have another session starting soon',
            },
          ],
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: errorSchema(404, 'Booking 123e4567-... not found', 'Not Found'),
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: errorSchema(401, 'Unauthorized', 'Unauthorized'),
  })
  async getExtensionHistory(
    @Req() req: any,
    @Param('bookingId') bookingId: string,
  ) {
    const userId = req.user?.id;
    return this.sessionExtensionService.getExtensionHistory(bookingId, userId);
  }

  // agora ncs webhook
  @Post('ncs/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Agora NCS webhook endpoint',
    description:
      'Receives Agora Notification Callback Service (NCS) events for channel lifecycle management. ' +
      '**This endpoint is called by Agora servers, not by the frontend.** ' +
      'eventType 103 (broadcaster joined) → auto-starts cloud recording. ' +
      'eventType 102 (channel destroyed) → stops recording and uploads to S3.',
  })
  @ApiBody({ type: NcsEventDto })
  @ApiOkResponse({
    description: 'Event received and processed',
    schema: {
      example: {
        success: true,
        message: 'Event received',
        data: { received: true },
      },
    },
  })
  async handleNcsWebhook(@Body() dto: NcsEventDto) {
    this.logger.log(
      `NCS webhook received: eventType=${dto.eventType} productId=${dto.productId ?? 'n/a'} noticeId=${dto.noticeId ?? 'n/a'} sid=${dto.sid ?? 'n/a'} payload=${JSON.stringify(dto.payload ?? {})}`,
    );

    // Dispatch Hazel recording channels to their own handler so we don't lose
    // Agora errorCode / leaveCode detail in the studio "unknown channel" warn.
    const channelName = dto.payload?.cname ?? dto.payload?.channelName;
    if (HazelNcsHandlerService.isHazelChannel(channelName)) {
      await this.hazelNcsHandler.handleEvent(
        dto.eventType,
        dto.payload,
        dto.productId,
      );
    } else {
      await this.agoraChannelService.handleNcsEvent(
        dto.eventType,
        dto.payload,
        dto.productId,
      );
    }
    return {
      success: true,
      message: 'Event received',
      data: { received: true },
    };
  }
}
