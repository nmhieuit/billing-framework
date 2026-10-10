import { createTestBroker, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, silentLog } from './test-helpers.js';
import type { OutgoingMessage } from './types.js';

let broker: TestBroker;
let client: BrokerClient;

const paid = (messageId: string): OutgoingMessage => ({
  exchange: 'billing.events',
  routingKey: 'order-paid.v1',
  messageId,
  type: 'OrderPaidV1',
  correlationId: 'corr-9',
  body: JSON.stringify({ orderId: 'o1' }),
});

beforeAll(async () => {
  broker = await createTestBroker('pub');
  client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
});
afterAll(async () => {
  await client.close();
  await broker.drop();
});

describe('ConfirmPublisher', () => {
  it('reports unroutable when no queue is bound (the broker still confirms such messages)', async () => {
    expect(await client.publisher.publish(paid('m-unroutable'))).toEqual({ kind: 'unroutable' });
  });

  it('delivers with type, messageId, content type and correlation header once a consumer queue is bound', async () => {
    const ecommerce = await open(broker.ecommerce);
    const channel = await ecommerce.createChannel();
    await channel.assertQueue('ecommerce.results', { durable: true });
    await channel.bindQueue('ecommerce.results', 'billing.events', 'order-paid.v1');

    expect(await client.publisher.publish(paid('m-1'))).toEqual({ kind: 'delivered' });

    const message = await channel.get('ecommerce.results', { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(JSON.parse(message.content.toString())).toEqual({ orderId: 'o1' });
    expect(message.properties).toMatchObject({
      messageId: 'm-1',
      type: 'OrderPaidV1',
      contentType: 'application/json',
      deliveryMode: 2,
    });
    expect(message.properties.headers?.['x-correlation-id']).toBe('corr-9');
    await ecommerce.close();
  });

  it('fails (never throws) after the client is closed', async () => {
    const other = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    await other.close();
    const result = await other.publisher.publish(paid('m-closed'));
    expect(result.kind).toBe('failed');
  });

  it('settles many concurrent publishes independently', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => client.publisher.publish(paid(`m-c${i}`))),
    );
    expect(results.every((r) => r.kind === 'delivered')).toBe(true);
  });
});
