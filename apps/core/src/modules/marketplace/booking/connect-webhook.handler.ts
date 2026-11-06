/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { StripeConnectService } from '../reader-profile/stripe-connect.service';
import { BookingService } from './booking.service';
import { ConnectPaymentService } from './connect-payment.service';

// handles Stripe Connect-specific webhook events for marketplace payments
@Injectable()
export class ConnectWebhookHandler {
  private readonly logger = new Logger(ConnectWebhookHandler.name);

  constructor(
    private readonly connectPaymentService: ConnectPaymentService,
    private readonly stripeConnectService: StripeConnectService,
    private readonly bookingService: BookingService,
  ) {}

  // route a Stripe event to the appropriate handler. returns true if the event was handled, false if not a Connect event.
  async handleEvent(event: Stripe.Event): Promise<boolean> {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        await this.connectPaymentService.handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent,
        );
        // confirm the booking via BookingService (updates slot status)
        const successPI = event.data.object as Stripe.PaymentIntent;
        const successBookingId = successPI.metadata?.bookingId;
        if (successBookingId) {
          await this.bookingService.confirmBooking(successBookingId);
        }
        return true;
      }

      case 'payment_intent.payment_failed': {
        await this.connectPaymentService.handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent,
        );
        const failedPI = event.data.object as Stripe.PaymentIntent;
        const failedBookingId = failedPI.metadata?.bookingId;
        if (failedBookingId) {
          await this.bookingService.handlePaymentFailure(failedBookingId);
        }
        return true;
      }

      case 'transfer.created':
        await this.connectPaymentService.handleTransferCreated(
          event.data.object as Stripe.Transfer,
        );
        return true;

      case 'transfer.reversed':
        await this.connectPaymentService.handleTransferReversed(
          event.data.object as Stripe.Transfer,
        );
        return true;

      case 'refund.created':
      case 'refund.updated':
      case 'refund.failed':
        await this.connectPaymentService.handleRefundUpdated(
          event.data.object as Stripe.Refund,
        );
        return true;

      case 'charge.refunded':
        await this.connectPaymentService.handleChargeRefunded(
          event.data.object as Stripe.Charge,
        );
        return true;

      case 'account.updated': {
        const account = event.data.object as Stripe.Account;
        await this.stripeConnectService.handleAccountUpdated(account.id);
        return true;
      }

      case 'payout.paid':
        this.logger.log(`Payout completed: ${(event.data.object as any).id}`);
        return true;

      case 'payout.failed':
        this.logger.warn(`Payout failed: ${(event.data.object as any).id}`);
        return true;

      default:
        // transfer.failed is not in Stripe's event type union but can be received
        if ((event.type as string) === 'transfer.failed') {
          await this.connectPaymentService.handleTransferFailed(
            event.data.object as unknown as Stripe.Transfer,
          );
          return true;
        }
        return false;
    }
  }
}
