import { signWebhook } from '@billing/contracts';
import type { WebhookSender, WebhookSendResult } from '../application/ports.js';
import type { WebhookEvent } from '../domain/webhook-event.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HttpWebhookSenderOptions {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpWebhookSender implements WebhookSender {
  constructor(private readonly options: HttpWebhookSenderOptions) {}

  async send(event: WebhookEvent, now: Date): Promise<WebhookSendResult> {
    const { eventId, payload } = event.toProps();
    const timestamp = Math.floor(now.getTime() / 1000);
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(this.options.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-signature': signWebhook(this.options.secret, payload, timestamp),
          'x-webhook-event-id': eventId,
        },
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return { ok: true, statusCode: response.status };
      return { ok: false, statusCode: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
