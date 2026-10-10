import { createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import type { ConfirmChannel } from 'amqplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, publishAsOrders, silentLog, testTopology } from './test-helpers.js';
import { deadLetterQueueName } from './topology.js';
import type { HandlerResult, IncomingMessage } from './types.js';

let broker: TestBroker;
let client: BrokerClient;
let ordersChannel: ConfirmChannel;
let closeOrders: () => Promise<void>;

// Mỗi ca dùng queue VÀ cặp exchange work/retry riêng: nếu dùng chung exchange + routing key, message retry/DLQ của
// ca này sẽ được broker nhân bản sang queue của các ca trước (cùng key) và quay lại làm nhiễu đếm số lần gọi.
const topology = (delays: readonly number[]) => {
  const id = Math.random().toString(36).slice(2, 8);
  return {
    ...testTopology(delays),
    queue: `wallet.q${id}`,
    workExchange: `wallet.work.${id}`,
    retryExchange: `wallet.retry.${id}`,
  };
};

beforeAll(async () => {
  broker = await createTestBroker('cons');
  const orders = await open(broker.ecommerce);
  ordersChannel = await orders.createConfirmChannel();
  closeOrders = () => orders.close();
});
afterAll(async () => {
  await closeOrders();
  await broker.drop();
});
beforeEach(async () => {
  client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
});
afterEach(async () => {
  await client.close();
});

async function queueDepth(name: string): Promise<number> {
  const admin = await open(broker.admin);
  const channel = await admin.createChannel();
  const { messageCount } = await channel.checkQueue(name);
  await admin.close();
  return messageCount;
}

describe('consumer', () => {
  it('acks a handled message and hands the handler the body, ids and retry count', async () => {
    const t = topology([1]);
    const seen: IncomingMessage[] = [];
    await client.consume({
      topology: t,
      prefetch: 2,
      handler: async (m) => {
        seen.push(m);
        return { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o1' }, { messageId: 'evt-1' });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      messageId: 'evt-1',
      type: 'OrderReadyForPaymentV1',
      redelivered: false,
      retryCount: 0,
    });
    expect(JSON.parse(seen[0]?.body.toString() ?? '')).toEqual({ orderId: 'o1' });
    await waitFor(async () => (await queueDepth(t.queue)) === 0);
  });

  it('retries through the TTL tiers with an increasing x-retry-count, then succeeds', async () => {
    const t = topology([1, 2]);
    const timeline: Array<{ count: number; at: number }> = [];
    const started = Date.now();
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async (m): Promise<HandlerResult> => {
        timeline.push({ count: m.retryCount, at: Date.now() - started });
        return m.retryCount < 2 ? { action: 'retry', reason: 'db down' } : { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o2' }, { messageId: 'evt-2' });
    await waitFor(() => timeline.length === 3, { timeoutMs: 15_000 });
    expect(timeline.map((x) => x.count)).toEqual([0, 1, 2]);
    expect(timeline[1]!.at - timeline[0]!.at).toBeGreaterThanOrEqual(800);
    expect(timeline[2]!.at - timeline[1]!.at).toBeGreaterThanOrEqual(1800);
  });

  it('dead-letters once the tiers are exhausted and keeps the last error', async () => {
    const t = topology([1]);
    let calls = 0;
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async () => {
        calls += 1;
        return { action: 'retry', reason: 'still broken' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o3' }, { messageId: 'evt-3' });
    await waitFor(async () => (await queueDepth(deadLetterQueueName(t.queue))) === 1, {
      timeoutMs: 15_000,
    });
    expect(calls).toBe(2);
    const admin = await open(broker.admin);
    const channel = await admin.createChannel();
    const dead = await channel.get(deadLetterQueueName(t.queue), { noAck: true });
    expect(dead).not.toBe(false);
    if (dead !== false) {
      expect(dead.properties.messageId).toBe('evt-3');
      expect(String(dead.properties.headers?.['x-dead-letter-reason'])).toContain('still broken');
      expect(JSON.parse(dead.content.toString())).toEqual({ orderId: 'o3' });
    }
    await admin.close();
    expect(await queueDepth(t.queue)).toBe(0);
  });

  it('rejects straight to the DLQ without retrying', async () => {
    const t = topology([1]);
    let calls = 0;
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async () => {
        calls += 1;
        return { action: 'reject', reason: 'schema invalid' };
      },
    });
    await publishAsOrders(ordersChannel, { nope: true }, { messageId: 'evt-4' });
    await waitFor(async () => (await queueDepth(deadLetterQueueName(t.queue))) === 1, {
      timeoutMs: 15_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls).toBe(1);
  });

  it('treats a throwing handler as a retry', async () => {
    const t = topology([1]);
    const counts: number[] = [];
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async (m) => {
        counts.push(m.retryCount);
        if (m.retryCount === 0) throw new Error('boom');
        return { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o5' }, { messageId: 'evt-5' });
    await waitFor(() => counts.length === 2, { timeoutMs: 15_000 });
    expect(counts).toEqual([0, 1]);
  });

  it('never runs more handlers at once than the prefetch', async () => {
    const t = topology([1]);
    let active = 0;
    let peak = 0;
    let finished = 0;
    await client.consume({
      topology: t,
      prefetch: 2,
      handler: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active -= 1;
        finished += 1;
        return { action: 'ack' };
      },
    });
    for (let i = 0; i < 6; i++)
      await publishAsOrders(ordersChannel, { i }, { messageId: `evt-p${i}` });
    await waitFor(() => finished === 6, { timeoutMs: 15_000 });
    expect(peak).toBe(2);
  });

  it('stopConsuming() waits for the handler that is still running and acks it', async () => {
    const t = topology([1]);
    let release: () => void = () => undefined;
    let started = false;
    let done = false;
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async () => {
        started = true;
        await new Promise<void>((resolve) => (release = resolve));
        done = true;
        return { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o7' }, { messageId: 'evt-7' });
    await waitFor(() => started);

    let stopped = false;
    const stopping = client.stopConsuming().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(done).toBe(true);
    await waitFor(async () => (await queueDepth(t.queue)) === 0);
  });
});
