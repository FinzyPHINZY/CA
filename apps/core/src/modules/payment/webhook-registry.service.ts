/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IWebhookHandler } from './webhook-handler.interface';

@Injectable()
export class WebhookRegistryService {
  private readonly logger = new Logger(WebhookRegistryService.name);
  private readonly handlers = new Map<string, IWebhookHandler>();

  // register a webhook handler
  registerHandler(handler: IWebhookHandler): void {
    if (this.handlers.has(handler.handlerId)) {
      this.logger.warn(
        `Webhook handler ${handler.handlerId} is already registered. Overwriting.`,
      );
    }
    this.handlers.set(handler.handlerId, handler);
    this.logger.log(`Registered webhook handler: ${handler.handlerId}`);
  }

  // unregister a webhook handler
  unregisterHandler(handlerId: string): void {
    if (this.handlers.delete(handlerId)) {
      this.logger.log(`Unregistered webhook handler: ${handlerId}`);
    }
  }

  // get a webhook handler by ID
  getHandler(handlerId: string): IWebhookHandler | undefined {
    return this.handlers.get(handlerId);
  }

  // get all registered handler IDs
  getRegisteredHandlers(): string[] {
    return Array.from(this.handlers.keys());
  }

  // process webhook for a specific handler
  async processWebhook(
    handlerId: string,
    payload: string | Buffer,
    signature: string,
    secret: string,
    event: any,
  ): Promise<void> {
    const handler = this.getHandler(handlerId);
    if (!handler) {
      throw new BadRequestException(
        `Webhook handler '${handlerId}' not found. Available handlers: ${this.getRegisteredHandlers().join(', ')}`,
      );
    }

    // Verify signature
    if (!handler.verifySignature(payload, signature, secret)) {
      throw new BadRequestException('Invalid webhook signature');
    }

    // Process event
    await handler.handleEvent(event);
  }
}
