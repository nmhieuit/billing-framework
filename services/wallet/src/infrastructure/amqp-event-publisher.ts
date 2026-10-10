import type { ConfirmPublisher } from '@billing/messaging';
import type { EventPublisher, OutboxMessage, PublishOutcome } from '../application/ports.js';

export const BILLING_EVENTS_EXCHANGE = 'billing.events';

/** Adapter của cổng `EventPublisher`: đẩy payload outbox nguyên văn lên exchange `billing.events`. */
export class AmqpEventPublisher implements EventPublisher {
  constructor(private readonly publisher: Pick<ConfirmPublisher, 'publish'>) {}

  publish(message: OutboxMessage): Promise<PublishOutcome> {
    return this.publisher.publish({
      exchange: BILLING_EVENTS_EXCHANGE,
      routingKey: message.routingKey,
      messageId: message.id,
      type: message.eventType,
      correlationId: message.correlationId,
      body: message.payload,
    });
  }
}
