/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CreateActorReviewDto,
  UpdateActorReviewDto,
} from './dto/create-actor-review.dto';
import { CreateReviewDto, UpdateReviewDto } from './dto/create-review.dto';
import { ActorReviewService } from './actor-review.service';
import { ReviewService } from './review.service';

@ApiTags('Reviews')
@Controller()
export class ReviewController {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly actorReviewService: ActorReviewService,
  ) {}

  @Post('bookings/:id/review')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Create a review for a finished booking (completed or awaiting settlement)',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiNotFoundResponse({
    description: 'Booking not found',
    schema: {
      example: {
        success: false,
        message: 'Booking not found',
        statusCode: 404,
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Only the actor can review this booking',
    schema: {
      example: {
        success: false,
        message: 'Only the actor can review this booking',
        statusCode: 403,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Can only review completed bookings',
    schema: {
      example: {
        success: false,
        message: 'Can only review completed bookings',
        statusCode: 400,
      },
    },
  })
  @ApiConflictResponse({
    description: 'A review already exists for this booking',
    schema: {
      example: {
        success: false,
        message: 'A review already exists for this booking',
        statusCode: 409,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async createReview(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviewService.createReview(bookingId, req.user.id, dto);
  }

  @Patch('reviews/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Edit a review (within 48h window)' })
  @ApiParam({ name: 'id', description: 'Review ID (UUID)' })
  @ApiNotFoundResponse({
    description: 'Review not found',
    schema: {
      example: { success: false, message: 'Review not found', statusCode: 404 },
    },
  })
  @ApiForbiddenResponse({
    description: 'Not your review',
    schema: {
      example: { success: false, message: 'Not your review', statusCode: 403 },
    },
  })
  @ApiBadRequestResponse({
    description: 'Edit window has closed (>48h since creation)',
    schema: {
      example: {
        success: false,
        message: 'Edit window has closed',
        statusCode: 400,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT token',
    schema: {
      example: {
        success: false,
        message: 'Missing or invalid JWT token',
        statusCode: 401,
      },
    },
  })
  async updateReview(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewService.updateReview(id, req.user.id, dto);
  }

  @Get('readers/:id/reviews')
  @ApiOperation({ summary: 'List reviews for a reader (paginated)' })
  @ApiParam({ name: 'id', description: 'Reader profile ID (UUID)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiNotFoundResponse({
    description: 'Reader profile not found',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found',
        statusCode: 404,
      },
    },
  })
  async listReviewsForReader(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.reviewService.listReviewsForReader(
      id,
      page ? Number(page) : 1,
      limit ? Number(limit) : 10,
    );
  }

  // ── Actor review endpoints (reader reviews actor) ────────────────────────

  @Post('bookings/:id/actor-review')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary:
      'Create a review for the actor on a finished booking — completed or awaiting settlement (reader only)',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiNotFoundResponse({ description: 'Booking not found' })
  @ApiForbiddenResponse({
    description: 'Only the reader can review this booking',
  })
  @ApiBadRequestResponse({ description: 'Can only review completed bookings' })
  @ApiConflictResponse({
    description: 'A review already exists for this booking',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async createActorReview(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) bookingId: string,
    @Body() dto: CreateActorReviewDto,
  ) {
    return this.actorReviewService.createActorReview(
      bookingId,
      req.user.id,
      dto,
    );
  }

  @Patch('actor-reviews/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Edit an actor review (within 48h window)' })
  @ApiParam({ name: 'id', description: 'Actor Review ID (UUID)' })
  @ApiNotFoundResponse({ description: 'Review not found' })
  @ApiForbiddenResponse({ description: 'Not your review' })
  @ApiBadRequestResponse({
    description: 'Edit window has closed (>48h since creation)',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async updateActorReview(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActorReviewDto,
  ) {
    return this.actorReviewService.updateActorReview(id, req.user.id, dto);
  }

  @Get('actors/:userId/reviews')
  @ApiOperation({ summary: 'List reviews received by an actor (paginated)' })
  @ApiParam({ name: 'userId', description: 'Actor user ID (UUID)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listReviewsForActor(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.actorReviewService.listReviewsForActor(
      userId,
      page ? Number(page) : 1,
      limit ? Number(limit) : 10,
    );
  }
}
