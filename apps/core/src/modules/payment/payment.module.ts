/** biome-ignore-all lint/style/useImportType: <> */
import { Module, OnModuleInit } from '@nestjs/common';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { StripeWebhookHandler } from './handlers/stripe-webhook.handler';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { WebhookRegistryService } from './webhook-registry.service';

@Module({
  imports: [SubscriptionModule, MarketplaceModule],
  controllers: [PaymentController],
  providers: [PaymentService, WebhookRegistryService, StripeWebhookHandler],
  exports: [PaymentService, WebhookRegistryService],
})
export class PaymentModule implements OnModuleInit {
  constructor(
    private readonly webhookRegistry: WebhookRegistryService,
    private readonly stripeHandler: StripeWebhookHandler,
  ) {}

  onModuleInit() {
    // Register Stripe webhook handler
    this.webhookRegistry.registerHandler(this.stripeHandler);
  }
}
