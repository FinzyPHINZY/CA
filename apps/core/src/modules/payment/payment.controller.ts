/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PaymentService } from './payment.service';
import { WebhookRegistryService } from './webhook-registry.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly webhookRegistry: WebhookRegistryService,
    private readonly configService: ConfigService,
  ) {}

  @Post('intent')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create payment intent',
    description:
      'Creates a generic Stripe payment intent. This is not the marketplace booking payment flow. For actor bookings, frontend should use POST /api/bookings/:id/pay instead.',
  })
  @ApiBody({
    description: 'Payment intent data',
    schema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: 'Payment amount in cents',
          example: 2000,
        },
        currency: {
          type: 'string',
          description: 'Currency code (default: usd)',
          example: 'usd',
        },
      },
      required: ['amount'],
    },
  })
  @ApiCreatedResponse({
    description: 'Payment intent created successfully',
    schema: {
      example: {
        success: true,
        message: 'Payment intent created successfully',
        data: { clientSecret: 'pi_xxx_secret_xxx', id: 'pi_xxx' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid payment data provided' })
  async createPaymentIntent(
    @Body() paymentDto: { amount: number; currency?: string },
  ) {
    return this.paymentService.createPaymentIntent(
      paymentDto.amount,
      paymentDto.currency,
    );
  }

  @Post('subscription')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create subscription',
    description: 'Creates a new subscription with payment method for a user',
  })
  @ApiBody({
    description: 'Subscription creation data',
    schema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          description: 'User unique identifier',
          example: 'user-123',
        },
        plan: {
          type: 'string',
          description: 'Subscription plan identifier',
          example: 'premium',
        },
        paymentMethodId: {
          type: 'string',
          description: 'Stripe payment method ID',
          example: 'pm_1234567890',
        },
        email: {
          type: 'string',
          description: 'User email address',
          example: 'user@example.com',
        },
      },
      required: ['userId', 'plan', 'paymentMethodId', 'email'],
    },
  })
  @ApiCreatedResponse({
    description: 'Subscription created successfully',
    schema: {
      example: {
        success: true,
        message: 'Subscription created successfully',
        data: {
          subscription: { id: 'uuid', plan: 'premium', status: 'active' },
          clientSecret: 'pi_xxx_secret_xxx',
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Invalid subscription data provided' })
  async createSubscription(
    @Body()
    subscriptionDto: {
      userId: string;
      plan: string;
      paymentMethodId: string;
      email: string;
    },
  ) {
    return this.paymentService.createSubscription(
      subscriptionDto.userId,
      subscriptionDto.plan as any,
      subscriptionDto.paymentMethodId,
      subscriptionDto.email,
    );
  }

  @Post('webhook/:service')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Internal generic webhook endpoint for payment providers',
    description:
      'Internal server-to-server endpoint used by Stripe and other payment providers. Frontend clients should not call this route. For marketplace booking payments, frontend should call POST /api/bookings/:id/pay and complete payment with Stripe.js using the returned clientSecret.',
  })
  @ApiParam({
    name: 'service',
    description: 'Service identifier (e.g., stripe, paypal, etc.)',
    example: 'stripe',
    type: String,
  })
  @ApiQuery({
    name: 'secret',
    required: false,
    description:
      'Webhook secret key (can also be provided via X-Webhook-Secret header or environment variable)',
    type: String,
  })
  async handleWebhook(
    @Param('service') service: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('stripe-signature') stripeSignature: string,
    @Headers('x-webhook-signature') webhookSignature: string,
    @Headers('x-webhook-secret') webhookSecretHeader: string,
    @Query('secret') secretQuery: string,
  ) {
    // Collect all candidate secrets for this service.
    // For Stripe, we support two webhook endpoints (platform + Connect) with
    // separate signing secrets. The controller tries each secret until one
    // passes signature verification.
    const serviceSecretKey = `${service.toUpperCase()}_WEBHOOK_SECRET`;
    const connectSecretKey = `${service.toUpperCase()}_CONNECT_WEBHOOK_SECRET`;
    const candidateSecrets: string[] = [
      secretQuery,
      webhookSecretHeader,
      this.configService.get<string>(serviceSecretKey),
      this.configService.get<string>(connectSecretKey),
      this.configService.get<string>('WEBHOOK_SECRET'),
    ].filter((s): s is string => !!s);

    if (candidateSecrets.length === 0) {
      return res.status(500).json({
        error: `Webhook secret not configured for service: ${service}`,
        hint: 'Provide secret via query param, X-Webhook-Secret header, or environment variable',
      });
    }

    // get signature from headers (different services use different header names)
    const signature = stripeSignature || webhookSignature;

    if (!signature) {
      return res.status(400).json({
        error: 'Webhook signature not provided',
        hint: 'Include signature in Stripe-Signature or X-Webhook-Signature header',
      });
    }

    // get handler for this service
    const handler = this.webhookRegistry.getHandler(service.toLowerCase());

    if (!handler) {
      const availableHandlers = this.webhookRegistry.getRegisteredHandlers();
      return res.status(400).json({
        error: `Webhook handler for service '${service}' not found`,
        availableHandlers,
        hint: 'Register a handler using WebhookRegistryService.registerHandler()',
      });
    }

    try {
      // Try each candidate secret until signature verification succeeds
      let verifiedSecret: string | null = null;
      for (const secret of candidateSecrets) {
        if (handler.verifySignature(req.rawBody, signature, secret)) {
          verifiedSecret = secret;
          break;
        }
      }

      if (!verifiedSecret) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      // parse event (handler-specific)
      let event: any;
      if (service.toLowerCase() === 'stripe') {
        const stripeHandler = handler as any;
        if (stripeHandler.constructEvent) {
          event = stripeHandler.constructEvent(
            req.rawBody,
            signature,
            verifiedSecret,
          );
        } else {
          event = this.paymentService.constructWebhookEvent(
            req.rawBody,
            signature,
            verifiedSecret,
          );
        }
      } else {
        // for other services, parse JSON body
        try {
          event = JSON.parse(req.rawBody.toString());
        } catch (parseError: any) {
          return res.status(400).json({
            error: 'Invalid webhook payload',
            details: parseError.message,
          });
        }
      }

      // process event
      await handler.handleEvent(event);

      res.json({
        received: true,
        service,
        eventType: event.type || event.event_type || 'unknown',
      });
    } catch (error: any) {
      return res.status(500).json({
        error: 'Webhook processing failed',
        message: error.message,
        service,
      });
    }
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stripe webhook endpoint (legacy)',
    description:
      'Legacy endpoint for Stripe webhooks. For new integrations, use POST /payments/webhook/stripe. This endpoint is maintained for backward compatibility.',
    deprecated: true,
  })
  async handleStripeWebhookLegacy(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Headers('stripe-signature') signature: string,
  ) {
    // redirect to new endpoint
    return this.handleWebhook(
      'stripe',
      req,
      res,
      signature,
      undefined,
      undefined,
      undefined,
    );
  }
}
