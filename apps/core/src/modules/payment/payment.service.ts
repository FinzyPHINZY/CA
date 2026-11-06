/* eslint-disable @typescript-eslint/no-unused-vars */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useImportType: <> */

import { SubscriptionPlan, SubscriptionStatus } from '@app/common';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { ConnectWebhookHandler } from '../marketplace/booking/connect-webhook.handler';
import { SubscriptionService } from '../subscription/subscription.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);
  private stripe: Stripe;

  // map subscription plans to Stripe Price IDs (set these in environment variables)
  private readonly STRIPE_PRICE_IDS: Record<
    SubscriptionPlan,
    string | undefined
  > = {
    [SubscriptionPlan.FREE]: undefined,
    [SubscriptionPlan.STARTER]: this.configService.get<string>(
      'STRIPE_PRICE_STARTER',
    ),
    [SubscriptionPlan.PREMIUM]: this.configService.get<string>(
      'STRIPE_PRICE_PREMIUM',
    ),
    [SubscriptionPlan.ALL_ACCESS]: this.configService.get<string>(
      'STRIPE_PRICE_ALL_ACCESS',
    ),
  };

  constructor(
    private configService: ConfigService,
    private subscriptionService: SubscriptionService,
    private readonly connectWebhookHandler: ConnectWebhookHandler,
  ) {
    const stripeKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (stripeKey) {
      this.stripe = new Stripe(stripeKey, {
        apiVersion: '2025-11-17.clover',
      });
    }
  }

  // get Stripe instance for webhook verification
  getStripe(): Stripe | undefined {
    return this.stripe;
  }

  // verify and construct webhook event
  constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): Stripe.Event {
    if (!this.stripe) {
      throw new Error('Stripe is not configured');
    }
    return this.stripe.webhooks.constructEvent(payload, signature, secret);
  }

  // create or get Stripe customer for user
  async getOrCreateCustomer(
    userId: string,
    email: string,
  ): Promise<Stripe.Customer> {
    // check if user already has a subscription with Stripe customer ID
    const existingSubscription =
      await this.subscriptionService.findByUserId(userId);

    if (existingSubscription?.stripeCustomerId) {
      try {
        const customer = await this.stripe.customers.retrieve(
          existingSubscription.stripeCustomerId,
        );
        if (!customer.deleted) {
          return customer as Stripe.Customer;
        }
      } catch (error) {
        this.logger.warn(
          `Stripe customer ${existingSubscription.stripeCustomerId} not found, creating new one`,
        );
      }
    }

    // create new Stripe customer
    const customer = await this.stripe.customers.create({
      email,
      metadata: { userId },
    });

    this.logger.log(
      `Created Stripe customer ${customer.id} for user ${userId}`,
    );
    return customer;
  }

  async createPaymentIntent(
    amount: number,
    currency: string = 'usd',
  ): Promise<any> {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }

    const intent = await this.stripe.paymentIntents.create({
      amount: amount * 100, // Convert to cents
      currency,
    });

    return {
      success: true,
      message: 'Payment intent created successfully',
      data: { clientSecret: intent.client_secret, id: intent.id },
    };
  }

  // create subscription with Stripe
  async createSubscription(
    userId: string,
    plan: SubscriptionPlan,
    paymentMethodId: string,
    email: string,
  ): Promise<any> {
    if (!this.stripe) {
      throw new BadRequestException('Stripe is not configured');
    }

    if (plan === SubscriptionPlan.FREE) {
      throw new BadRequestException(
        'Cannot create paid subscription for FREE plan',
      );
    }

    const priceId = this.STRIPE_PRICE_IDS[plan];
    if (!priceId) {
      throw new BadRequestException(
        `No Stripe price ID configured for plan: ${plan}`,
      );
    }

    // get or create customer
    const customer = await this.getOrCreateCustomer(userId, email);

    // attach payment method to customer
    await this.stripe.paymentMethods.attach(paymentMethodId, {
      customer: customer.id,
    });

    // set as default payment method
    await this.stripe.customers.update(customer.id, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    // create subscription
    const stripeSubscription = await this.stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { userId, plan },
    });

    // create local subscription record
    const subscription = await this.subscriptionService.create({
      userId,
      plan,
      status: SubscriptionStatus.ACTIVE,
      stripeCustomerId: customer.id,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId: priceId,
      expiresAt: stripeSubscription['current_period_end']
        ? new Date((stripeSubscription as any).current_period_end * 1000)
        : undefined,
    });

    const latestInvoice = (stripeSubscription as any)?.latest_invoice;
    const paymentIntent = latestInvoice?.payment_intent;

    this.logger.log(
      `Created subscription ${subscription.id} for user ${userId} with Stripe subscription ${stripeSubscription.id}`,
    );

    return {
      success: true,
      message: 'Subscription created successfully',
      data: {
        subscription,
        clientSecret: paymentIntent?.client_secret,
      },
    };
  }

  // handle Stripe webhook events
  async handleWebhook(event: Stripe.Event): Promise<void> {
    this.logger.log(`Received Stripe webhook event: ${event.type}`);

    try {
      const handledByConnect =
        await this.connectWebhookHandler.handleEvent(event);
      if (handledByConnect) {
        this.logger.log(`Delegated Stripe event ${event.type} to marketplace`);
        return;
      }

      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await this.handleSubscriptionUpdate(
            event.data.object as Stripe.Subscription,
          );
          break;
        case 'customer.subscription.deleted':
          await this.handleSubscriptionCancelled(
            event.data.object as Stripe.Subscription,
          );
          break;
        case 'invoice.payment_succeeded':
          await this.handlePaymentSucceeded(
            event.data.object as Stripe.Invoice,
          );
          break;
        case 'invoice.payment_failed':
          await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;
        case 'payment_intent.succeeded':
        case 'payment_intent.payment_failed':
        case 'transfer.created':
        case 'transfer.reversed':
        case 'payout.paid':
        case 'payout.failed':
        case 'account.updated':
        case 'refund.created':
        case 'refund.updated':
        case 'refund.failed':
        case 'charge.refunded':
          this.logger.warn(
            `Stripe event ${event.type} was not claimed by marketplace handler`,
          );
          break;
        default:
          this.logger.debug(`Unhandled webhook event type: ${event.type}`);
      }
    } catch (error) {
      this.logger.error(
        `Error handling webhook event ${event.type}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private async handleSubscriptionUpdate(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const localSub = await this.subscriptionService.findByStripeSubscriptionId(
      subscription.id,
    );

    if (!localSub) {
      this.logger.warn(
        `Subscription not found for Stripe subscription ${subscription.id}`,
      );
      return;
    }

    const status =
      subscription.status === 'active'
        ? SubscriptionStatus.ACTIVE
        : SubscriptionStatus.EXPIRED;

    // Workaround: Stripe.Subscription's type may not include current_period_end (missing from typings).
    // Use `any` to access it, but also guard for undefined.
    const currentPeriodEnd =
      (subscription as any).current_period_end ||
      (subscription as any).currentPeriodEnd;

    const expiresAt = currentPeriodEnd
      ? new Date(currentPeriodEnd * 1000)
      : null;

    await this.subscriptionService.update(localSub.id, {
      status,
      expiresAt,
    });

    this.logger.log(`Updated subscription ${localSub.id} status to ${status}`);
  }

  private async handleSubscriptionCancelled(
    subscription: Stripe.Subscription,
  ): Promise<void> {
    const localSub = await this.subscriptionService.findByStripeSubscriptionId(
      subscription.id,
    );

    if (localSub) {
      await this.subscriptionService.cancel(localSub.id);
      this.logger.log(`Cancelled subscription ${localSub.id}`);
    }
  }

  private async handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
    // Stripe.Invoice typings do not include `subscription`
    // Per Stripe docs, `subscription` is a string or undefined
    // Stripe.Invoice typings do not include `subscription`, so access via type casting
    const subscriptionId =
      typeof (invoice as any).subscription === 'string'
        ? (invoice as any).subscription
        : (invoice as any).subscription?.id;

    if (subscriptionId) {
      const localSub =
        await this.subscriptionService.findByStripeSubscriptionId(
          subscriptionId,
        );

      if (localSub) {
        await this.subscriptionService.update(localSub.id, {
          status: SubscriptionStatus.ACTIVE,
        });
        this.logger.log(`Payment succeeded for subscription ${localSub.id}`);
      }
    }
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    // Stripe.Invoice typings do not include `subscription` property, so we access it via type casting
    const subscriptionId =
      typeof (invoice as any).subscription === 'string'
        ? (invoice as any).subscription
        : (invoice as any).subscription?.id;

    const localSub =
      await this.subscriptionService.findByStripeSubscriptionId(subscriptionId);

    if (localSub) {
      this.logger.warn(`Payment failed for subscription ${localSub.id}`);
      // Optionally update status or send notification
    }
  }
}
