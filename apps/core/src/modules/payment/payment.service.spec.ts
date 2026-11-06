/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { SubscriptionStatus } from '@app/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { ConnectWebhookHandler } from '../marketplace/booking/connect-webhook.handler';
import { SubscriptionService } from '../subscription/subscription.service';
import { PaymentService } from './payment.service';

describe('PaymentService', () => {
  let service: PaymentService;
  let subscriptionService: jest.Mocked<Partial<SubscriptionService>>;
  let connectWebhookHandler: jest.Mocked<Partial<ConnectWebhookHandler>>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    subscriptionService = {
      findByStripeSubscriptionId: jest.fn(),
      update: jest.fn(),
      cancel: jest.fn(),
      findByUserId: jest.fn(),
      create: jest.fn(),
    };

    connectWebhookHandler = {
      handleEvent: jest.fn().mockResolvedValue(false),
    };

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') return 'sk_test_123';
        if (key === 'STRIPE_PRICE_STARTER') return 'price_starter';
        if (key === 'STRIPE_PRICE_PREMIUM') return 'price_premium';
        if (key === 'STRIPE_PRICE_ALL_ACCESS') return 'price_all_access';
        return undefined;
      }),
    } as unknown as ConfigService;

    service = new PaymentService(
      configService,
      subscriptionService as unknown as SubscriptionService,
      connectWebhookHandler as unknown as ConnectWebhookHandler,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('delegates marketplace connect events to ConnectWebhookHandler', async () => {
    connectWebhookHandler.handleEvent!.mockResolvedValue(true);

    await service.handleWebhook({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_123', metadata: { bookingId: 'booking-1' } } },
    } as unknown as Stripe.Event);

    expect(connectWebhookHandler.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment_intent.succeeded' }),
    );
    expect(
      subscriptionService.findByStripeSubscriptionId,
    ).not.toHaveBeenCalled();
  });

  it('falls back to subscription handling for non-marketplace events', async () => {
    subscriptionService.findByStripeSubscriptionId!.mockResolvedValue({
      id: 'sub-local-1',
    } as any);
    subscriptionService.update!.mockResolvedValue({} as any);

    await service.handleWebhook({
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_stripe_1' } },
    } as unknown as Stripe.Event);

    expect(connectWebhookHandler.handleEvent).toHaveBeenCalled();
    expect(subscriptionService.findByStripeSubscriptionId).toHaveBeenCalledWith(
      'sub_stripe_1',
    );
    expect(subscriptionService.update).toHaveBeenCalledWith('sub-local-1', {
      status: SubscriptionStatus.ACTIVE,
    });
  });
});
