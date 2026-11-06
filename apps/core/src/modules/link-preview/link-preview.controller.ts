/** biome-ignore-all lint/style/useImportType: <> */
import { JwtAuthGuard } from '@app/common';
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { LinkPreviewService } from './link-preview.service';

@ApiTags('Link Preview')
@Controller('link-preview')
export class LinkPreviewController {
  constructor(private readonly linkPreviewService: LinkPreviewService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Fetch link preview metadata for a URL',
    description:
      'Returns title and thumbnail for any URL. ' +
      'Uses oEmbed for YouTube, Vimeo, and SoundCloud (fast, ~200ms). ' +
      'Falls back to Open Graph tag scraping for all other URLs (capped at 4s / 100KB). ' +
      'Results are cached in Redis for 24 hours — repeat calls for the same URL are ~5ms.',
  })
  @ApiQuery({
    name: 'url',
    required: true,
    description: 'Fully-qualified URL to preview',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
  @ApiOkResponse({
    description:
      'Preview metadata fetched (title and/or thumbnailUrl may be null if the target page has no OG tags)',
    schema: {
      example: {
        success: true,
        message: 'Link preview fetched successfully',
        data: {
          title: 'Shakespeare Monologue Reel',
          thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
          platform: 'youtube',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'url param is missing or is not a valid URL',
    schema: {
      example: {
        success: false,
        message: 'url must be a valid URL',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Unauthorized',
        statusCode: 401,
      },
    },
  })
  async preview(@Query('url') url: string) {
    if (!url) {
      throw new BadRequestException('url query param is required');
    }

    try {
      new URL(url);
    } catch {
      throw new BadRequestException('url must be a valid URL');
    }

    const result = await this.linkPreviewService.preview(url);
    return {
      success: true,
      message: 'Link preview fetched successfully',
      data: result,
    };
  }
}
