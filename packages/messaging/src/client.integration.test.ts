import { createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, publishAsOrders, silentLog, testTopology } from './test-helpers.js';
import type { IncomingMessage } from './types.js';

let broker: TestBroker;

beforeAll(async () => {
  broker = await createTestBroker('client');
  const orders = await open(broker.ecommerce);
  const channel = await orders.createChannel();
  await channel.assertQueue('ecommerce.results', { durable: true });
  await channel.bindQueue('ecommerce.results', 'billing.events', 'order-paid.v1');
  await orders.close();
});
afterAll(async () => {
  await broker.drop();
});

/** Mỗi lần dùng mở kết nối ecommerce mới: `closeConnections` xóa MỌI kết nối của vhost, kể cả của bên đóng vai ecommerce. */
async function publishFromOrders(body: unknown, messageId: string): Promise<void> {
  const orders = await open(broker.ecommerce);
  try {
    const channel = await orders.createConfirmChannel();
    await publishAsOrders(channel, body, { messageId });
  } finally {
    await orders.close().catch(() => undefined);
  }
}

describe('BrokerClient recovery', () => {
  it('keeps consuming and publishing after the broker drops every connection', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const topology = { ...testTopology([1]), queue: 'wallet.recovery' };
    const handled: string[] = [];
    await client.consume({
      topology,
      prefetch: 2,
      handler: async (m) => {
        handled.push(m.messageId ?? '');
        return { action: 'ack' };
      },
    });

    await publishFromOrders({ n: 1 }, 'before');
    await waitFor(() => handled.includes('before'));

    expect(await broker.closeConnections()).toBeGreaterThan(0);

    // Sau khi kết nối lại: consumer nhận tiếp (thử publish đến khi thấy) và publisher publish được.
    let attempt = 0;
    await waitFor(
      async () => {
        await publishFromOrders({ n: 2 }, `after-${attempt++}`).catch(() => undefined);
        return handled.some((id) => id.startsWith('after-'));
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    await waitFor(
      async () =>
        (
          await client.publisher.publish({
            exchange: 'billing.events',
            routingKey: 'order-paid.v1',
            messageId: 'recovered-publish',
            type: 'OrderPaidV1',
            correlationId: 'c',
            body: '{}',
          })
        ).kind === 'delivered',
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    await client.close();
  });

  it('redelivers a message whose handler never acknowledged before the connection died', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const topology = { ...testTopology([1]), queue: 'wallet.redelivery' };
    const deliveries: IncomingMessage[] = [];
    await client.consume({
      topology,
      prefetch: 1,
      handler: async (m) => {
        deliveries.push(m);
        if (deliveries.length === 1) return new Promise<never>(() => undefined);
        return { action: 'ack' };
      },
    });
    await publishFromOrders({ orderId: 'o-redeliver' }, 'evt-redeliver');
    await waitFor(() => deliveries.length === 1);

    expect(await broker.closeConnections()).toBeGreaterThan(0);

    await waitFor(() => deliveries.length >= 2, { timeoutMs: 30_000 });
    expect(deliveries[1]).toMatchObject({ messageId: 'evt-redeliver', redelivered: true });
    await client.close();
  });

  it('fails fast at startup when the broker cannot be reached', async () => {
    await expect(
      BrokerClient.connect({
        config: { ...broker.wallet, port: 1 },
        log: silentLog,
        initialMaxRetries: 1,
      }),
    ).rejects.toThrow();
  });

  it('fails startup with a clear error when a source exchange is missing', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    await expect(
      client.consume({
        topology: {
          ...testTopology(),
          queue: 'wallet.bad',
          bindings: [{ exchange: 'orders.missing', routingKey: 'x' }],
        },
        prefetch: 1,
        handler: async () => ({ action: 'ack' }),
      }),
    ).rejects.toThrow(/NOT_FOUND|404/);
    await client.close();
  });
});
