/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  Feature,
  FeatureGuard,
  JwtAuthGuard,
  RequireFeature,
} from '@app/common';
import { DeepgramService } from '../cue-engine/deepgram.service';
import { TeleprompterSessionService } from './teleprompter-session.service';
import { DEEPGRAM_TOKEN_RESPONSE_EXAMPLE } from './dto/deepgram-token-response.dto';

@ApiTags('Teleprompter Solo')
@Controller('teleprompter')
@UseGuards(JwtAuthGuard, FeatureGuard)
@RequireFeature(Feature.TELEPROMPTER)
export class TeleprompterController {
  private readonly logger = new Logger(TeleprompterController.name);

  constructor(
    private readonly deepgramService: DeepgramService,
    private readonly sessionService: TeleprompterSessionService,
  ) {}

  @Get('deepgram-token')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get an ephemeral Deepgram session token',
    description:
      "Issues a scoped, short-lived Deepgram session key (`usage:write` only — cannot manage keys or access billing). The FE opens a Deepgram WebSocket directly from the browser using this key, then forwards transcripts to the teleprompter gateway via the `transcript.received` event. Default TTL is 2 hours; the key is automatically revoked when `session.end` fires.",
  })
  @ApiOkResponse({
    description: 'Deepgram session token',
    schema: { example: DEEPGRAM_TOKEN_RESPONSE_EXAMPLE },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      "Subscription tier does not include the TELEPROMPTER feature. Upgrade to Premium or All-Access.",
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example:
            'Feature TELEPROMPTER is not available in your subscription plan. Please upgrade to access this feature.',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  @ApiServiceUnavailableResponse({
    description:
      'Deepgram management API is unreachable. Retry; the FE may proceed in MANUAL mode without a Deepgram token.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 503 },
        message: {
          type: 'string',
          example: 'Failed to issue Deepgram token',
        },
        error: { type: 'string', example: 'Service Unavailable' },
      },
    },
  })
  async getDeepgramToken(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    const handle = `tp-user-${userId}`;
    const key = await this.deepgramService.createSessionKey(handle);
    return {
      success: true,
      message: 'Deepgram token issued',
      data: {
        token: key.apiKey,
        keyId: key.keyId,
        model: this.deepgramService.model,
        config: {
          interim_results: true,
          punctuate: true,
          smart_format: true,
          endpointing: 300,
        },
      },
    };
  }

  @Delete('session/:rehearsalId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Force-reset a stuck teleprompter session',
    description:
      'Recovery path. Wipes the Redis session state, revokes the Deepgram key (if any), and marks the underlying Rehersal row as CANCELLED. Use only when the WebSocket `session.end` flow cannot clean up (e.g. socket disconnected without ack). Idempotent.',
  })
  @ApiParam({
    name: 'rehearsalId',
    description: 'Rehearsal UUID whose session should be reset.',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Session reset',
    schema: {
      example: { success: true, message: 'Session reset' },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      "Subscription tier does not include the TELEPROMPTER feature, or caller does not own the rehearsal.",
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You do not own this rehearsal',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'No Redis session state found for this rehearsal.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example: 'Teleprompter session not found: <rehearsalId>',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  async forceResetSession(
    @Req() req: any,
    @Param('rehearsalId') rehearsalId: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    await this.sessionService.forceReset(rehearsalId, userId);
    return { success: true, message: 'Session reset' };
  }
}
