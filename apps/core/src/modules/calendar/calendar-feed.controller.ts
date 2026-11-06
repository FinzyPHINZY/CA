/** biome-ignore-all lint/style/useImportType: <> */
import { JwtAuthGuard } from '@app/common';
import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { CalendarFeedService } from './calendar-feed.service';

@ApiTags('Calendar')
@Controller('calendar')
export class CalendarFeedController {
  constructor(private readonly calendarFeedService: CalendarFeedService) {}

  @Get('feed/:userId/:token.ics')
  @ApiOperation({
    summary: 'Download webcal ICS feed',
    description:
      'Public endpoint — no JWT required. The token in the URL path authenticates the request. ' +
      'Calendar apps (Google Calendar, Apple Calendar, Outlook) subscribe to this URL and poll it ' +
      'automatically. Returns all confirmed and in-progress sessions for the user as VEVENT entries. ' +
      'Do not call this directly from the frontend — use the `webcal://` URL from `/api/calendar/feed-url` ' +
      "to trigger the calendar subscription dialog in the user's calendar app.",
  })
  @ApiParam({
    name: 'userId',
    description: 'UUID of the user whose sessions to return.',
  })
  @ApiParam({
    name: 'token',
    description:
      'Secret feed token from GET /api/calendar/feed-url. Invalidated on rotate.',
  })
  @ApiResponse({
    status: 200,
    description: 'ICS file containing all upcoming confirmed sessions.',
    content: {
      'text/calendar': {
        schema: {
          type: 'string',
          example: [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//CueActor//CueActor Calendar//EN',
            'X-WR-CALNAME:CueActor Sessions',
            'BEGIN:VEVENT',
            'UID:abc123@cueactor.com',
            'SUMMARY:CueActor Script Reading Session',
            'DTSTART:20250315T140000Z',
            'DTEND:20250315T150000Z',
            'STATUS:CONFIRMED',
            'END:VEVENT',
            'END:VCALENDAR',
          ].join('\r\n'),
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired feed token.' })
  async getFeed(
    @Param('userId') userId: string,
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const ics = await this.calendarFeedService.buildIcsContent(userId, token);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="cueactor-sessions.ics"',
    );
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(ics);
  }

  @Get('feed-url')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get webcal subscription URL',
    description:
      "Returns the authenticated user's webcal feed URL and per-provider subscription instructions. " +
      'Works for all users (actors and readers). Generates a `feedToken` on first call — subsequent ' +
      'calls return the same URL. Use the `webcal://` URL to trigger the subscription dialog in the ' +
      "user's calendar app. Use `POST /api/calendar/feed/rotate` to invalidate and regenerate the URL.",
  })
  @ApiResponse({
    status: 200,
    description: 'Feed URL and subscription instructions retrieved.',
    schema: {
      example: {
        success: true,
        message: 'Calendar feed URL retrieved successfully',
        data: {
          feedUrl:
            'webcal://api.cueactor.com/api/calendar/feed/{userId}/{token}.ics',
          httpUrl:
            'https://api.cueactor.com/api/calendar/feed/{userId}/{token}.ics',
          instructions: {
            google:
              "In Google Calendar, click '+' next to 'Other calendars', select 'From URL', paste the URL above and click 'Add calendar'.",
            apple:
              'On iPhone/iPad: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, paste the URL. On Mac: Calendar app → File → New Calendar Subscription.',
            outlook:
              "In Outlook.com, go to Calendar → Add calendar → Subscribe from web, paste the URL and click 'Import'.",
          },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  async getFeedUrl(@Req() req: any) {
    const data = await this.calendarFeedService.getFeedUrl(req.user.id);
    return {
      success: true,
      message: 'Calendar feed URL retrieved successfully',
      data,
    };
  }

  @Post('feed/rotate')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Rotate feed token',
    description:
      'Generates a new feed token, immediately invalidating the old webcal URL. ' +
      'Any calendar app subscribed to the old URL will stop receiving updates until the user ' +
      're-subscribes with the new URL. Use this if the URL has been accidentally exposed.',
  })
  @ApiResponse({
    status: 201,
    description: 'New feed token generated. Old webcal URL is now invalid.',
    schema: {
      example: {
        success: true,
        message: 'Feed token rotated. Old webcal URL is now invalid.',
        data: {
          feedUrl:
            'webcal://api.cueactor.com/api/calendar/feed/{userId}/{newToken}.ics',
          httpUrl:
            'https://api.cueactor.com/api/calendar/feed/{userId}/{newToken}.ics',
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  async rotateFeedToken(@Req() req: any) {
    const data = await this.calendarFeedService.rotateFeedToken(req.user.id);
    return {
      success: true,
      message: 'Feed token rotated. Old webcal URL is now invalid.',
      data,
    };
  }
}
