import type { OutgoingMessage, PublishResult } from '@billing/messaging';
import { describe, expect, it } from 'vitest';
import type { OutboxMessage } from '../application/ports.js';
import { AmqpEventPublisher, BILLING_EVENTS_EXCHANGE } from './amqp-event-publisher.js';

const message: OutboxMessage = {
  id: '00000000-0000-4000-8000-000000000001',
  eventType: 'OrderPaidV1',
  routingKey: 'order-paid.v1',
  payload: '{"orderId":"o1"}',
  correlationId: 'corr-1',
  createdAt: new Date('2026-10-10T10:00:00.000Z'),
  attempts: 2,
  nextAttemptAt: new Date('2026-10-10T10:00:00.000Z'),
};

describe('AmqpEventPublisher', () => {
  it('publishes the stored payload verbatim to billing.events with the event identity', async () => {
    const sent: OutgoingMessage[] = [];
    const publisher = new AmqpEventPublisher({
      publish: async (m): Promise<PublishResult> => {
        sent.push(m);
        return { kind: 'delivered' };
      },
    });

    expect(await publisher.publish(message)).toEqual({ kind: 'delivered' });
    expect(sent).toEqual([
      {
        exchange: 'billing.events',
        routingKey: 'order-paid.v1',
        messageId: message.id,
        type: 'OrderPaidV1',
        correlationId: 'corr-1',
        body: '{"orderId":"o1"}',
      },
    ]);
    expect(BILLING_EVENTS_EXCHANGE).toBe('billing.events');
  });

  it.each<PublishResult>([{ kind: 'unroutable' }, { kind: 'failed', error: 'no confirm' }])(
    'passes %j through unchanged',
    async (result) => {
      const publisher = new AmqpEventPublisher({ publish: async () => result });
      expect(await publisher.publish(message)).toEqual(result);
    },
  );
});
