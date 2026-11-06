import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  ValidationPipe,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { JwtAuthGuard } from '@app/common';

const subscriptionExample = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  userId: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
  plan: 'PREMIUM',
  status: 'ACTIVE',
  expiresAt: '2025-02-15T10:30:00.000Z',
  stripeCustomerId: 'cus_1234567890',
  stripeSubscriptionId: 'sub_1234567890',
  stripePriceId: 'price_1234567890',
  createdAt: '2025-01-15T10:30:00.000Z',
  updatedAt: '2025-01-15T10:30:00.000Z',
  deletedAt: null,
};

@ApiTags('Subscriptions')
@Controller('subscriptions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('access-token')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get subscription by ID',
    description:
      'Retrieves a specific subscription by its unique identifier. Returns complete subscription details including plan, status, expiration date, and Stripe integration information.',
  })
  @ApiParam({
    name: 'id',
    description: 'Subscription unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Subscription found and returned successfully',
    schema: {
      example: {
        success: true,
        message: 'Subscription retrieved successfully',
        data: subscriptionExample,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Subscription with the provided ID was not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Subscription with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
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
  async findOne(@Param('id') id: string) {
    return this.subscriptionService.findById(id);
  }

  @Get('me')
  @ApiOperation({
    summary: "Get current user's subscription",
    description:
      'Retrieves the subscription for the currently authenticated user. Returns null if the user has no active or expired subscriptions. This is the recommended endpoint for users to check their own subscription status.',
  })
  @ApiOkResponse({
    description:
      "Current user's subscription found (or null data if no subscription exists)",
    schema: {
      example: {
        success: true,
        message: 'Subscription retrieved successfully',
        data: subscriptionExample,
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
  async getMySubscription(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedException('User ID not found in request.');
    }
    return this.subscriptionService.findByUserId(userId);
  }

  @Get('user/:userId')
  @ApiOperation({
    summary: 'Get subscription by user ID',
    description:
      "Retrieves the most recent subscription for a specific user by their user ID. Returns null if the user has no active or expired subscriptions. Useful for administrative purposes or checking other users' subscription status.",
  })
  @ApiParam({
    name: 'userId',
    description: 'User unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
  })
  @ApiOkResponse({
    description:
      'User subscription found (or null data if no subscription exists)',
    schema: {
      example: {
        success: true,
        message: 'Subscription retrieved successfully',
        data: subscriptionExample,
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
  async findByUser(@Param('userId') userId: string) {
    return this.subscriptionService.findByUserId(userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new subscription',
    description:
      'Creates a new subscription for a user. Typically used internally by the payment service when a user subscribes via Stripe. Requires userId, plan, and expiresAt. Status defaults to ACTIVE if not provided.',
  })
  @ApiBody({
    description: 'Subscription creation data',
    type: CreateSubscriptionDto,
  })
  @ApiCreatedResponse({
    description: 'Subscription created successfully',
    schema: {
      example: {
        success: true,
        message: 'Subscription created successfully',
        data: subscriptionExample,
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid subscription data provided. Common errors: missing required fields (userId, plan, expiresAt), invalid enum values, invalid date format, or invalid UUID format.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'string' },
              example: [
                'userId must be a UUID',
                'plan must be one of the following values: FREE, STARTER, PREMIUM, ALL_ACCESS',
                'expiresAt must be a valid ISO 8601 date string',
              ],
            },
            {
              type: 'string',
              example: 'Invalid subscription data provided',
            },
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
  async create(
    @Body(ValidationPipe) createSubscriptionDto: CreateSubscriptionDto,
  ) {
    const subscriptionData = {
      ...createSubscriptionDto,
      expiresAt: new Date(createSubscriptionDto.expiresAt),
    };
    return this.subscriptionService.create(subscriptionData);
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update subscription',
    description:
      'Updates an existing subscription with new data. Can be used to change the plan, update status, extend expiration date, or update Stripe integration fields. All fields are optional - only provided fields will be updated.',
  })
  @ApiParam({
    name: 'id',
    description: 'Subscription unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiBody({
    description: 'Updated subscription data (all fields optional)',
    type: UpdateSubscriptionDto,
  })
  @ApiOkResponse({
    description: 'Subscription updated successfully',
    schema: {
      example: {
        success: true,
        message: 'Subscription updated successfully',
        data: {
          ...subscriptionExample,
          plan: 'ALL_ACCESS',
          updatedAt: '2025-01-20T14:45:00.000Z',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Subscription with the provided ID was not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Subscription with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Invalid subscription data provided. Common errors: invalid enum values, invalid date format, or invalid UUID format.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          oneOf: [
            {
              type: 'array',
              items: { type: 'string' },
              example: [
                'plan must be one of the following values: FREE, STARTER, PREMIUM, ALL_ACCESS',
                'status must be one of the following values: ACTIVE, EXPIRED, CANCELLED',
                'expiresAt must be a valid ISO 8601 date string',
              ],
            },
            {
              type: 'string',
              example: 'Invalid subscription data provided',
            },
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
  async update(
    @Param('id') id: string,
    @Body(ValidationPipe) updateSubscriptionDto: UpdateSubscriptionDto,
  ) {
    const subscriptionData = {
      ...updateSubscriptionDto,
      ...(updateSubscriptionDto.expiresAt && {
        expiresAt: new Date(updateSubscriptionDto.expiresAt),
      }),
    };
    return this.subscriptionService.update(id, subscriptionData);
  }

  @Put(':id/cancel')
  @ApiOperation({
    summary: 'Cancel subscription',
    description:
      'Cancels an active subscription by setting its status to CANCELLED. This is a soft cancellation - the subscription record remains in the database but is marked as cancelled. The subscription will not be automatically renewed. Typically called when a user cancels their subscription through Stripe or the application.',
  })
  @ApiParam({
    name: 'id',
    description: 'Subscription unique identifier (UUID)',
    type: 'string',
    format: 'uuid',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiOkResponse({
    description: 'Subscription cancelled successfully',
    schema: {
      example: {
        success: true,
        message: 'Subscription cancelled successfully',
        data: {
          ...subscriptionExample,
          status: 'CANCELLED',
          updatedAt: '2025-01-20T15:00:00.000Z',
        },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Subscription with the provided ID was not found',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: {
          type: 'string',
          example:
            'Subscription with ID 123e4567-e89b-12d3-a456-426614174000 not found',
        },
        error: { type: 'string', example: 'Not Found' },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Subscription cannot be cancelled. This may occur if the subscription is already cancelled or in an invalid state.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: {
          type: 'string',
          example: 'Subscription is already cancelled',
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
  async cancel(@Param('id') id: string) {
    return this.subscriptionService.cancel(id);
  }
}
