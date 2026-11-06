/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { JwtAuthGuard } from '@app/common';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { BookingService } from './booking.service';
import { ConnectPaymentService } from './connect-payment.service';
import { InstantConnectService } from './instant-connect.service';
import {
  CancelBookingDto,
  CreateBookingDto,
  GetAvailabilityQueryDto,
} from './dto/create-booking.dto';
import {
  DeclineInstantConnectDto,
  InstantConnectDto,
} from './dto/instant-connect.dto';
import {
  CreateBookingResponseDto,
  CreateBookingPaymentIntentResponseDto,
  GetBookingResponseDto,
  ListBookingsResponseDto,
} from './dto/booking-response.dto';
import { SlotGenerationService } from './slot-generation.service';

@ApiTags('Bookings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class BookingController {
  constructor(
    private readonly bookingService: BookingService,
    private readonly slotGenerationService: SlotGenerationService,
    private readonly connectPaymentService: ConnectPaymentService,
    private readonly instantConnectService: InstantConnectService,
  ) {}

  @Get('readers/:id/availability')
  @ApiOperation({
    summary: 'Get available slots for a reader on a specific date',
  })
  @ApiParam({ name: 'id', description: 'Reader user ID (UUID)' })
  @ApiQuery({ name: 'date', required: true, example: '2025-03-15' })
  @ApiQuery({ name: 'timezone', required: false, example: 'America/New_York' })
  @ApiNotFoundResponse({
    description: 'Reader not found',
    schema: {
      example: { success: false, message: 'Reader not found', statusCode: 404 },
    },
  })
  @ApiBadRequestResponse({
    description: 'Invalid date format or missing date parameter',
    schema: {
      example: {
        success: false,
        message: 'Invalid date format',
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
  async getReaderAvailability(
    @Param('id', ParseUUIDPipe) readerId: string,
    @Query() query: GetAvailabilityQueryDto,
  ) {
    // trigger slot generation for this reader (idempotent)
    await this.slotGenerationService.generateSlotsForReader(readerId);

    return this.slotGenerationService.getAvailableSlots(
      readerId,
      query.date,
      query.timezone,
    );
  }

  @Post('bookings')
  @ApiOperation({
    summary: 'Create a booking (acquires slot lock, sets status to held)',
  })
  @ApiNotFoundResponse({
    description: 'Reader profile or time slot not found',
    schema: {
      example: {
        success: false,
        message: 'Time slot not found',
        statusCode: 404,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Cannot book yourself, slot in the past, or reader not accepting bookings',
    schema: {
      example: {
        success: false,
        message: 'Cannot book yourself',
        statusCode: 400,
      },
    },
  })
  @ApiConflictResponse({
    description:
      'Time slot is no longer available or being held by another user',
    schema: {
      example: {
        success: false,
        message: 'Time slot is no longer available',
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
  @ApiCreatedResponse({
    description:
      'Booking created successfully. Includes actor and reader display summaries, and reader genres.',
    type: CreateBookingResponseDto,
  })
  async createBooking(@Req() req: any, @Body() dto: CreateBookingDto) {
    return this.bookingService.createBooking(req.user.id, dto);
  }

  @Get('bookings')
  @ApiOperation({ summary: 'List bookings for authenticated user' })
  @ApiQuery({ name: 'role', required: false, enum: ['actor', 'reader'] })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({
    description:
      'Paginated bookings including actor and reader display summaries, reader genres, and financial state.',
    type: ListBookingsResponseDto,
  })
  async listBookings(
    @Req() req: any,
    @Query('role') role?: 'actor' | 'reader',
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.bookingService.listBookings(req.user.id, {
      role,
      status,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Get booking details' })
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
    description: 'Not authorized to view this booking',
    schema: {
      example: {
        success: false,
        message: 'Not authorized to view this booking',
        statusCode: 403,
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
  @ApiOkResponse({
    description:
      'Booking details including actor and reader display summaries, reader genres, and financial state.',
    type: GetBookingResponseDto,
  })
  async getBooking(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.bookingService.getBooking(id, req.user.id);
  }

  @Post('bookings/:id/cancel')
  @ApiOperation({
    summary: 'Cancel a booking (as actor — cancellation policy applies)',
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
    description: 'Not your booking',
    schema: {
      example: { success: false, message: 'Not your booking', statusCode: 403 },
    },
  })
  @ApiBadRequestResponse({
    description: 'Booking cannot be cancelled in its current status',
    schema: {
      example: {
        success: false,
        message: 'Booking cannot be cancelled in its current status',
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
  async cancelByActor(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookingService.cancelByActor(id, req.user.id, dto.reason);
  }

  @Post('bookings/:id/cancel-by-reader')
  @ApiOperation({
    summary: 'Cancel a booking (as reader — always full refund to actor)',
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
    description: 'Not your booking',
    schema: {
      example: { success: false, message: 'Not your booking', statusCode: 403 },
    },
  })
  @ApiBadRequestResponse({
    description: 'Booking cannot be cancelled in its current status',
    schema: {
      example: {
        success: false,
        message: 'Booking cannot be cancelled in its current status',
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
  async cancelByReader(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookingService.cancelByReader(id, req.user.id, dto.reason);
  }

  @Post('bookings/:id/pay')
  @ApiOperation({
    summary: 'Create a connected PaymentIntent for a held booking',
    description:
      'Frontend calls this after creating a held booking. It takes no request body and returns a Stripe clientSecret plus paymentIntentId. The frontend must then confirm the payment with Stripe.js/Elements. Booking confirmation happens asynchronously after Stripe calls the backend webhook.',
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
  @ApiBadRequestResponse({
    description:
      'Booking must be in held status to pay, or Stripe not configured',
    schema: {
      example: {
        success: false,
        message: 'Booking must be in held status to pay',
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
  @ApiCreatedResponse({
    description:
      'Stripe PaymentIntent created for the held booking. Use data.clientSecret on the frontend to complete payment with Stripe.',
    type: CreateBookingPaymentIntentResponseDto,
  })
  async createPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.connectPaymentService.createConnectedPaymentIntent(id);
  }

  // ── Instant Connect ─────────────────────────────────────────────────────

  @Post('bookings/instant-connect')
  @ApiOperation({
    summary: 'Request an instant connect session with an online reader',
    description:
      'Actor sends a live connect request to a reader. The reader receives a real-time WebSocket notification (`instant-connect.request`) and must accept or decline within 60 seconds. If no response, the request auto-expires. Creates a booking with status `pending_acceptance` and type `instant`. No timeslot is required.',
  })
  @ApiCreatedResponse({
    description:
      'Instant connect request sent. Reader has been notified via WebSocket. Actor should listen for `instant-connect.accepted`, `instant-connect.declined`, or `instant-connect.timeout` WebSocket events.',
    schema: {
      example: {
        booking: {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          actorUserId: '11111111-1111-1111-1111-111111111111',
          readerUserId: '22222222-2222-2222-2222-222222222222',
          readerProfileId: '33333333-3333-3333-3333-333333333333',
          timeSlotId: null,
          status: 'pending_acceptance',
          bookingType: 'instant',
          sessionDurationMinutes: 30,
          priceCents: 1500,
          currency: 'USD',
          platformFeeCents: 225,
          sessionStartUtc: '2026-03-25T14:00:00.000Z',
          sessionEndUtc: '2026-03-25T14:30:00.000Z',
          actor: { name: 'Jane Doe', avatar: 'https://...' },
        },
        expiresAt: '2026-03-25T14:01:30.000Z',
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Reader is offline, not accepting bookings, cannot book yourself, or requested duration not offered by reader',
    schema: {
      example: {
        success: false,
        message: 'Reader is not currently online',
        statusCode: 400,
      },
    },
  })
  @ApiConflictResponse({
    description:
      'Reader is currently busy (in a session or has a pending request), or another actor is already requesting this reader',
    schema: {
      example: {
        success: false,
        message: 'Reader is currently busy',
        statusCode: 409,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Reader profile not found or not accepting bookings',
    schema: {
      example: {
        success: false,
        message: 'Reader profile not found or not accepting bookings',
        statusCode: 404,
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
  async requestInstantConnect(@Req() req: any, @Body() dto: InstantConnectDto) {
    return this.instantConnectService.requestInstantConnect(req.user.id, dto);
  }

  @Post('bookings/:id/accept')
  @ApiOperation({
    summary: 'Accept an instant connect request (reader only)',
    description:
      'Reader accepts the incoming instant connect request. Booking transitions from `pending_acceptance` to `held`. Session times are reset to the moment of acceptance. The actor receives an `instant-connect.accepted` WebSocket event and should proceed to call `POST /bookings/:id/pay` to complete payment. After payment, both parties can join the session via `POST /sessions/:bookingId/start`.',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiOkResponse({
    description:
      'Request accepted. Booking is now held. Actor has been notified via WebSocket to complete payment.',
    schema: {
      example: {
        booking: {
          id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          status: 'held',
          bookingType: 'instant',
          sessionDurationMinutes: 30,
          priceCents: 1500,
          platformFeeCents: 225,
          sessionStartUtc: '2026-03-25T14:02:00.000Z',
          sessionEndUtc: '2026-03-25T14:32:00.000Z',
          actor: { name: 'Jane Doe', avatar: null },
          reader: { name: 'Alex Beecroft', avatar: 'https://...' },
        },
      },
    },
  })
  @ApiConflictResponse({
    description:
      'Request has expired (timed out after 60s) or is no longer pending acceptance',
    schema: {
      example: {
        success: false,
        message: 'This request has expired',
        statusCode: 409,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Authenticated user is not the reader for this booking',
    schema: {
      example: {
        success: false,
        message: 'You are not the reader for this booking',
        statusCode: 400,
      },
    },
  })
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
  async acceptInstantConnect(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.instantConnectService.acceptInstantConnect(id, req.user.id);
  }

  @Post('bookings/:id/decline')
  @ApiOperation({
    summary: 'Decline an instant connect request (reader only)',
    description:
      'Reader declines the incoming instant connect request. Booking is cancelled with `cancelledBy: reader`. The actor receives an `instant-connect.declined` WebSocket event and can try connecting with another reader. An optional decline reason can be provided.',
  })
  @ApiParam({ name: 'id', description: 'Booking ID (UUID)' })
  @ApiOkResponse({
    description:
      'Request declined. Booking cancelled. Actor has been notified via WebSocket.',
    schema: {
      example: { success: true },
    },
  })
  @ApiConflictResponse({
    description:
      'Request is no longer pending acceptance (already expired or handled)',
    schema: {
      example: {
        success: false,
        message: 'This request is no longer pending acceptance',
        statusCode: 409,
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Authenticated user is not the reader for this booking',
    schema: {
      example: {
        success: false,
        message: 'You are not the reader for this booking',
        statusCode: 400,
      },
    },
  })
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
  async declineInstantConnect(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineInstantConnectDto,
  ) {
    return this.instantConnectService.declineInstantConnect(
      id,
      req.user.id,
      dto.reason,
    );
  }

  @Get('payments/history')
  @ApiOperation({ summary: 'Payment history for authenticated user' })
  @ApiQuery({ name: 'role', required: false, enum: ['actor', 'reader'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getPaymentHistory(
    @Req() req: any,
    @Query('role') role?: 'actor' | 'reader',
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.connectPaymentService.getPaymentHistory(req.user.id, {
      role,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

  @Get('readers/earnings')
  @ApiOperation({ summary: 'Reader earnings dashboard data' })
  async getReaderEarnings(@Req() req: any) {
    return this.connectPaymentService.getReaderEarnings(req.user.id);
  }
}
