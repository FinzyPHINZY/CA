/** biome-ignore-all lint/style/useImportType: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TranscodeService } from './transcode.service';

@ApiTags('Transcode')
@Controller('transcode')
export class TranscodeController {
  constructor(private readonly transcodeService: TranscodeService) {}

  // submit a transcoding job for a recording. creates 720p and audio-only variants via AWS MediaConvert.
  @Post('recording/:recordingId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit recording transcode job',
    description:
      'Submits a transcoding job for a recording, creating 720p and audio-only variants. Requires MediaConvert configuration.',
  })
  @ApiParam({
    name: 'recordingId',
    description: 'Recording unique identifier',
    type: 'string',
  })
  @ApiOkResponse({
    description:
      'Transcode job submitted or completed (if MediaConvert is not configured)',
    schema: {
      example: {
        success: true,
        message: 'Transcode job submitted successfully',
        data: {
          recordingId: '123e4567-e89b-12d3-a456-426614174000',
          jobId: '1234567890123-abc123',
          status: 'IN_PROGRESS',
          variants: ['ORIGINAL', 'HD_720P', 'AUDIO_ONLY'],
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Recording or source media not found' })
  @ApiUnauthorizedResponse({
    description: 'Invalid or missing authentication token',
  })
  async submitTranscodeJob(@Param('recordingId') recordingId: string) {
    return this.transcodeService.submitRecordingTranscodeJob(recordingId);
  }

  // handle transcode job completion webhook (from EventBridge/SNS).
  @Post('webhook/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Handle transcode completion webhook',
    description:
      'Called by AWS EventBridge/SNS when a MediaConvert job completes or fails.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'MediaConvert job ID' },
        recordingId: {
          type: 'string',
          description: 'Recording ID from job metadata',
        },
        type: {
          type: 'string',
          description:
            'Job type from UserMetadata. "self-tape-stitch" routes to stitch handler, otherwise standard transcode.',
          example: 'self-tape-stitch',
        },
      },
      required: ['jobId', 'recordingId'],
    },
  })
  @ApiOkResponse({
    description: 'Webhook processed',
    schema: {
      example: {
        success: true,
        message: 'Webhook processed',
        data: { status: 'ok' },
      },
    },
  })
  async handleTranscodeWebhook(
    @Body('jobId') jobId: string,
    @Body('recordingId') recordingId: string,
    @Body('type') type?: string,
  ) {
    if (type === 'self-tape-stitch') {
      await this.transcodeService.handleStitchComplete(jobId, recordingId);
    } else {
      await this.transcodeService.handleTranscodeComplete(jobId, recordingId);
    }
    return {
      success: true,
      message: 'Webhook processed',
      data: { status: 'ok' },
    };
  }
}
