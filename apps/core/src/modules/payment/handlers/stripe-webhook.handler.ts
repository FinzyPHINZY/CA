import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { IWebhookHandler } from '../webhook-handler.interface';
import { PaymentService } from '../payment.service';

/**
 * Stripe webhook handler implementation
 */
@Injectable()
export class StripeWebhookHandler implements IWebhookHandler {
  readonly handlerId = 'stripe';
  private readonly logger = new Logger(StripeWebhookHandler.name);
  private stripe: Stripe;

  constructor(
    private configService: ConfigService,
    private paymentService: PaymentService,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-11-17.clover',
      });
    }
  }

  verifySignature(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): boolean {
    try {
      if (!this.stripe) {
        this.logger.error('Stripe is not configured');
        return false;
      }

      // Verify signature by constructing the event
      // This will throw if signature is invalid
      this.stripe.webhooks.constructEvent(payload, signature, secret);
      return true;
    } catch (error: any) {
      this.logger.error(
        `Stripe signature verification failed: ${error.message}`,
      );
      return false;
    }
  }

  async handleEvent(event: Stripe.Event): Promise<void> {
    this.logger.log(`Processing Stripe webhook event: ${event.type}`);
    // Delegate to PaymentService for actual processing
    await this.paymentService.handleWebhook(event);
  }

  /**
   * Construct Stripe event from payload (used by controller)
   * This is separate from verifySignature to avoid double verification
   */
  constructEvent(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): Stripe.Event {
    if (!this.stripe) {
      throw new Error('Stripe is not configured');
    }
    return this.stripe.webhooks.constructEvent(payload, signature, secret);
  }
}
