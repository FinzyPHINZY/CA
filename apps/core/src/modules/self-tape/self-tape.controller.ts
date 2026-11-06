/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CreateSelfTapeSessionDto } from './dto/create-self-tape-session.dto';
import { MarkTakeDto } from './dto/mark-take.dto';
import { StitchDto } from './dto/stitch.dto';
import { TitleCardDto } from './dto/title-card.dto';
import { SelfTapeService } from './self-tape.service';

@ApiTags('Self-Tape')
@Controller('self-tape')
export class SelfTapeController {
  constructor(private readonly selfTapeService: SelfTapeService) {}

  // list self-tape sessions for the authenticated user.
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List self-tape sessions',
    description:
      "Returns a paginated list of the authenticated user's self-tape recordings, ordered by most recent first.",
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiOkResponse({
    description: 'Self-tape sessions retrieved',
    schema: {
      example: {
        success: true,
        message: 'Self-tape sessions retrieved successfully',
        data: {
          items: [
            {
              id: '123e4567-e89b-12d3-a456-426614174000',
              status: 'READY',
              projectName: 'My Project',
              sceneHeading: 'INT. OFFICE - DAY',
              takesCount: 3,
              createdAt: '2026-03-29T10:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
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
  async listSessions(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.listSessions(
      userId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  // create a self-tape session - creates Agora channel + Recording, returns token and channel info.
  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create self-tape session',
    description:
      'Creates a new self-tape recording session. Sets up an Agora single-user channel and a Recording entity in self_tape mode. Returns the token and channel info needed to start recording.',
  })
  @ApiBody({ type: CreateSelfTapeSessionDto })
  @ApiCreatedResponse({
    description:
      'Self-tape session created — use the returned token and channelName to join the Agora channel',
    schema: {
      example: {
        success: true,
        message: 'Self-tape session created successfully',
        data: {
          recordingId: '123e4567-e89b-12d3-a456-426614174000',
          channelName: 'selftape_abc123_1700000000000',
          token: 'agora_rtc_token_...',
          uid: 12345,
          appId: 'agora_app_id',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Validation failed or missing required fields',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        error: { type: 'string', example: 'Bad Request' },
      },
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
  async createSession(
    @Req() req: any,
    @Body(new ValidationPipe({ whitelist: true }))
    dto: CreateSelfTapeSessionDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.createSession(userId, dto);
  }

  // start cloud recording for a self-tape session.
  @Post(':recordingId/recording/start')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start cloud recording',
    description:
      'Starts Agora cloud recording for a self-tape session. Call this after the frontend has joined the Agora channel. Idempotent — safe to call if recording is already active.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Cloud recording started',
    schema: {
      example: {
        success: true,
        message: 'Cloud recording started successfully',
        data: {
          recordingId: '123e4567-e89b-12d3-a456-426614174000',
          sessionId: '123e4567-e89b-12d3-a456-426614174001',
          resourceId: 'agora-resource-id',
          sid: 'agora-sid',
          status: 'recording',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording or Agora session not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'No Agora session found for this recording. Create a session first.',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to access this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to access this recording',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async startRecording(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.startRecording(recordingId, userId);
  }

  // stop cloud recording and link output files to recording.
  @Post(':recordingId/recording/stop')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Stop cloud recording',
    description:
      'Stops Agora cloud recording, creates Media entities from the output files, and links them to the recording. Call this when the actor finishes recording.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Cloud recording stopped and files linked',
    schema: {
      example: {
        success: true,
        message: 'Cloud recording stopped successfully',
        data: {
          recordingId: '123e4567-e89b-12d3-a456-426614174000',
          filesRecorded: 2,
          mediaIds: ['media-id-1', 'media-id-2'],
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'No active cloud recording to stop',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example:
            'No active cloud recording for this session. Call startRecording first.',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description:
      'Recording not found (case 1) or no Agora session exists for this recording (case 2)',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          oneOf: [
            { example: 'Recording with ID <uuid> not found' },
            { example: 'No Agora session found for this recording.' },
          ],
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to access this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to access this recording',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async stopRecording(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.stopRecording(recordingId, userId);
  }

  // mark a take within a self-tape recording.
  @Post(':recordingId/take')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Mark a take',
    description:
      'Records the start and end timestamps of a take within the self-tape session. The frontend signals each take boundary. Timestamps are relative to the recording start in milliseconds.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({ type: MarkTakeDto })
  @ApiOkResponse({
    description: 'Take marked successfully',
    schema: {
      example: {
        success: true,
        message: 'Take marked successfully',
        data: { takeNumber: 1, startMs: 5000, endMs: 35000 },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Duplicate take number or invalid timestamps',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'Take number 1 already exists' },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Recording not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to modify this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async markTake(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: MarkTakeDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.markTake(recordingId, userId, dto);
  }

  // set or update the title card for a self-tape recording.
  @Post(':recordingId/title-card')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Set title card',
    description:
      'Sets or updates the title card for a self-tape recording. The title card includes actor name, agent name, scene name, and optional custom text. It will be composited as the first 5 seconds of the final export.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({ type: TitleCardDto })
  @ApiOkResponse({
    description: 'Title card set successfully',
    schema: {
      example: {
        success: true,
        message: 'Title card set successfully',
        data: {
          actorName: 'Jane Smith',
          agentName: 'Creative Artists Agency',
          sceneName: 'The Balcony Scene',
          customText: 'Audition for Romeo & Juliet',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Recording not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to modify this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async setTitleCard(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: TitleCardDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.setTitleCard(recordingId, userId, dto);
  }

  // submit a stitch job to assemble selected takes into a final MP4.
  @Post(':recordingId/stitch')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Stitch takes into final video',
    description:
      'Submits a transcoding job to trim the selected takes and concatenate them into a single final MP4. Optionally includes the title card as the first 5 seconds. The job runs asynchronously via AWS MediaConvert.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({ type: StitchDto })
  @ApiOkResponse({
    description:
      'Transcoding job submitted — poll recording status for completion',
    schema: {
      example: {
        success: true,
        message: 'Stitch job submitted successfully',
        data: {
          recordingId: '123e4567-e89b-12d3-a456-426614174000',
          jobId: 'mediaconvert-job-abc123',
          status: 'in_progress',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'No takes selected, invalid take references, or recording is not in a stitchable state',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example: 'No takes available for stitching',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Recording not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to modify this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async submitStitch(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: StitchDto,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.submitStitch(recordingId, userId, dto);
  }

  // get a signed download URL for the final stitched self-tape.
  @Get(':recordingId/export')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Export self-tape',
    description:
      'Returns a signed download URL for the final stitched MP4. The recording must be in READY status. Includes a suggested filename formatted as ActorName_SceneName_SelfTape.mp4.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Signed download URL valid for 15 minutes',
    schema: {
      example: {
        success: true,
        message: 'Export URL generated successfully',
        data: {
          url: 'https://s3.amazonaws.com/bucket/key?X-Amz-Signature=...',
          fileName: 'JaneSmith_BalconyScene_SelfTape.mp4',
          recording: {
            id: '123e4567-e89b-12d3-a456-426614174000',
            status: 'READY',
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Recording is not in READY status yet',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example: 'Recording is not ready for export',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording or exported media file not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Recording not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to access this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: { type: 'string', example: 'Forbidden resource' },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async getExportUrl(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.getExportUrl(recordingId, userId);
  }

  // delete a self-tape recording (soft delete).
  @Delete(':recordingId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete self-tape recording',
    description:
      'Soft-deletes a self-tape recording. Cannot delete while a stitch job is in progress.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording UUID',
    type: 'string',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Recording deleted',
    schema: {
      example: {
        success: true,
        message: 'Self-tape recording deleted successfully',
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Cannot delete while a stitch job is in progress',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example:
            'Cannot delete a recording while a stitch job is in progress.',
        },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Recording not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Recording with ID ... not found' },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not authorized to delete this recording',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 403 },
        message: {
          type: 'string',
          example: 'You are not authorized to access this recording',
        },
        error: { type: 'string', example: 'Forbidden' },
      },
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
  async deleteRecording(
    @Req() req: any,
    @Param('recordingId') recordingId: string,
  ) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.selfTapeService.deleteRecording(recordingId, userId);
  }
}
