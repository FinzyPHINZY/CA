/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
export interface IWebhookHandler {
  // unique identifier for this webhook handler
  readonly handlerId: string;

  // verify the webhook signature/authenticity
  verifySignature(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): boolean;

  // process the webhook event
  handleEvent(event: any): Promise<void>;
}
