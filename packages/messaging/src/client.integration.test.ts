import { createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, publishAsOrders, silentLog, testTopology } from './test-helpers.js';
import type { BrokerLogger, IncomingMessage, OutgoingMessage } from './types.js';

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

/** Mỗi ca có queue VÀ exchange work/retry riêng, tránh nhân bản message retry/DLQ giữa các ca. */
const isolated = (name: string, delays: readonly number[] = [1]) => ({
  ...testTopology(delays),
  queue: `wallet.${name}`,
  workExchange: `wallet.work.${name}`,
  retryExchange: `wallet.retry.${name}`,
});

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  details: object;
  message: string | undefined;
}

function capturingLog(): { log: BrokerLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) =>
    (details: object, message?: string): void => {
      entries.push({ level, details, message });
    };
  return { entries, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}

const paid = (messageId: string): OutgoingMessage => ({
  exchange: 'billing.events',
  routingKey: 'order-paid.v1',
  messageId,
  type: 'OrderPaidV1',
  correlationId: 'c',
  body: '{}',
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

/** Publish lặp lại (mỗi lần id mới) đến khi `handled` thấy một id có tiền tố `prefix`. */
async function publishUntilHandled(handled: string[], prefix: string, timeoutMs = 30_000) {
  let attempt = 0;
  await waitFor(
    async () => {
      await publishFromOrders({ n: attempt }, `${prefix}-${attempt++}`).catch(() => undefined);
      return handled.some((id) => id.startsWith(`${prefix}-`));
    },
    { timeoutMs, intervalMs: 500 },
  );
}

describe('BrokerClient recovery', () => {
  it('keeps consuming and publishing after the broker drops every connection', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const handled: string[] = [];
    await client.consume({
      topology: isolated('recovery'),
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
    await publishUntilHandled(handled, 'after');
    await waitFor(
      async () => (await client.publisher.publish(paid('recovered-publish'))).kind === 'delivered',
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    await client.close();
  });

  it('redelivers a message whose handler never acknowledged before the connection died, and close() is bounded by stopTimeoutMs', async () => {
    const { log, entries } = capturingLog();
    const client = await BrokerClient.connect({
      config: broker.wallet,
      log,
      stopTimeoutMs: 500,
    });
    const deliveries: IncomingMessage[] = [];
    await client.consume({
      topology: isolated('redelivery'),
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

    // Handler treo của kết nối cũ không được làm close() treo: nó chỉ chờ tối đa stopTimeoutMs rồi cảnh báo.
    const startedAt = Date.now();
    await client.close();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(entries.some((e) => e.level === 'warn' && /stop timeout/.test(e.message ?? ''))).toBe(
      true,
    );
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
          ...isolated('bad'),
          bindings: [{ exchange: 'orders.missing', routingKey: 'x' }],
        },
        prefetch: 1,
        handler: async () => ({ action: 'ack' }),
      }),
    ).rejects.toThrow(/NOT_FOUND|404/);
    await client.close();
  });

  it('rejects registering a consumer after the client started closing', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    await client.close();
    await expect(
      client.consume({
        topology: isolated('late'),
        prefetch: 1,
        handler: async () => ({ action: 'ack' }),
      }),
    ).rejects.toThrow(/closing/);
  });

  it('rejects a second queue that reuses the work or retry exchange of another consumer', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const first = isolated('first');
    await client.consume({
      topology: first,
      prefetch: 1,
      handler: async () => ({ action: 'ack' }),
    });
    await expect(
      client.consume({
        topology: { ...isolated('second'), workExchange: first.workExchange },
        prefetch: 1,
        handler: async () => ({ action: 'ack' }),
      }),
    ).rejects.toThrow(/one consumer queue per/);
    await expect(
      client.consume({
        topology: { ...isolated('third'), retryExchange: first.retryExchange },
        prefetch: 1,
        handler: async () => ({ action: 'ack' }),
      }),
    ).rejects.toThrow(/one consumer queue per/);
    await client.close();
  });
});

describe('BrokerClient channel-level recovery (connection stays up)', () => {
  it('reopens the publish channel after the broker closes it', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    // Publish tới exchange không tồn tại / không có quyền: broker đóng channel publish bằng lỗi 403/404.
    const bad = await client.publisher.publish({ ...paid('bad'), exchange: 'billing.nonexistent' });
    expect(bad.kind).toBe('failed');
    await waitFor(
      async () => (await client.publisher.publish(paid('after-close'))).kind === 'delivered',
      {
        timeoutMs: 15_000,
        intervalMs: 300,
      },
    );
    await client.close();
  });

  it('reopens the consume channel and resumes consumers after it is closed', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const handled: string[] = [];
    await client.consume({
      topology: isolated('chanclose'),
      prefetch: 1,
      handler: async (m) => {
        handled.push(m.messageId ?? '');
        return { action: 'ack' };
      },
    });
    const consumeChannel = client.channelsForTesting.consume;
    expect(consumeChannel).toBeDefined();
    await consumeChannel?.close();

    await publishUntilHandled(handled, 'resumed', 15_000);
    await client.close();
  });

  it('restarts a consumer the broker cancelled (its queue was deleted)', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const topology = isolated('cancelled');
    const handled: string[] = [];
    await client.consume({
      topology,
      prefetch: 1,
      handler: async (m) => {
        handled.push(m.messageId ?? '');
        return { action: 'ack' };
      },
    });
    const admin = await open(broker.admin);
    const channel = await admin.createChannel();
    await channel.deleteQueue(topology.queue);
    await admin.close();

    await publishUntilHandled(handled, 'restarted', 15_000);
    await client.close();
  });

  it('isolates a consumer whose topology fails during recovery: publisher stays up, error is logged, consumer resumes once fixed', async () => {
    const { log, entries } = capturingLog();
    const client = await BrokerClient.connect({ config: broker.wallet, log });
    const handled: string[] = [];
    await client.consume({
      topology: isolated('isolation'),
      prefetch: 1,
      handler: async (m) => {
        handled.push(m.messageId ?? '');
        return { action: 'ack' };
      },
    });

    // Làm hỏng topology cho lần setup kế tiếp: xóa exchange nguồn rồi cho broker cắt mọi kết nối.
    const admin = await open(broker.admin);
    const adminChannel = await admin.createChannel();
    await adminChannel.deleteExchange('orders.events');
    await admin.close();
    try {
      expect(await broker.closeConnections()).toBeGreaterThan(0);

      await waitFor(
        () =>
          entries.some(
            (e) => e.level === 'error' && /could not start consumer/.test(e.message ?? ''),
          ),
        { timeoutMs: 30_000, intervalMs: 300 },
      );
      await waitFor(
        async () => (await client.publisher.publish(paid('while-broken'))).kind === 'delivered',
        {
          timeoutMs: 15_000,
          intervalMs: 300,
        },
      );
    } finally {
      const fixer = await open(broker.admin);
      const fixChannel = await fixer.createChannel();
      await fixChannel.assertExchange('orders.events', 'topic', { durable: true });
      await fixer.close();
    }

    await publishUntilHandled(handled, 'fixed');
    await client.close();
  });
});
