import type { ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import { startConsumer } from './consumer.js';
import type { ConfirmPublisher } from './publisher.js';
import { silentLog, testTopology } from './test-helpers.js';
import type { HandlerResult, IncomingMessage, OutgoingMessage, PublishResult } from './types.js';

type Delivery = (raw: ConsumeMessage | null) => void;

function setup(options: {
  handler: (m: IncomingMessage) => Promise<HandlerResult>;
  publishResult?: PublishResult;
  delays?: readonly number[];
}) {
  let deliver: Delivery = () => undefined;
  const channel = {
    prefetch: vi.fn(async () => undefined),
    consume: vi.fn(async (_queue: string, callback: Delivery) => {
      deliver = callback;
      return { consumerTag: 'tag' };
    }),
    cancel: vi.fn(async () => undefined),
    ack: vi.fn(),
    nack: vi.fn(),
  };
  const published: Array<{ message: OutgoingMessage; headers: Record<string, unknown> }> = [];
  const publisher = {
    publish: vi.fn(async (message: OutgoingMessage, headers: Record<string, unknown> = {}) => {
      published.push({ message, headers });
      return options.publishResult ?? ({ kind: 'delivered' } as PublishResult);
    }),
  };
  const onCancel = vi.fn();
  const started = startConsumer({
    channel: channel as never,
    publisher: publisher as unknown as ConfirmPublisher,
    spec: {
      topology: testTopology(options.delays ?? [1, 2]),
      prefetch: 1,
      handler: options.handler,
    },
    log: silentLog,
    onCancel,
    requeueDelayMs: 0,
  });
  return {
    channel,
    published,
    onCancel,
    started,
    deliver: (raw: ConsumeMessage | null) => deliver(raw),
  };
}

const raw = (headers: Record<string, unknown> = {}): ConsumeMessage =>
  ({
    content: Buffer.from('{"a":1}'),
    fields: { redelivered: false },
    properties: { messageId: 'm-1', type: 'OrderReadyForPaymentV1', headers },
  }) as unknown as ConsumeMessage;

const retryHandler = async (): Promise<HandlerResult> => ({ action: 'retry', reason: 'down' });

describe('consumer failure paths (fake channel)', () => {
  it('requeues with nack when the forward publish fails', async () => {
    const t = setup({ handler: retryHandler, publishResult: { kind: 'failed', error: 'no conn' } });
    await t.started;
    const message = raw();
    t.deliver(message);
    await vi.waitFor(() => expect(t.channel.nack).toHaveBeenCalledWith(message, false, true));
    expect(t.channel.ack).not.toHaveBeenCalled();
  });

  it('requeues with nack when the forward is unroutable', async () => {
    const t = setup({ handler: retryHandler, publishResult: { kind: 'unroutable' } });
    await t.started;
    const message = raw();
    t.deliver(message);
    await vi.waitFor(() => expect(t.channel.nack).toHaveBeenCalledWith(message, false, true));
    expect(t.channel.ack).not.toHaveBeenCalled();
  });

  it('acks only after a successful forward and strips x-death, CC, BCC and the publish token', async () => {
    const t = setup({ handler: retryHandler });
    await t.started;
    const message = raw({
      'x-death': [{ count: 1 }],
      'x-first-death-queue': 'q',
      CC: ['somewhere.else'],
      BCC: ['hidden'],
      cc: ['lower'],
      'x-publish-id': 'old-token',
      'x-correlation-id': 'corr',
      custom: 'kept',
    });
    t.deliver(message);
    await vi.waitFor(() => expect(t.channel.ack).toHaveBeenCalledWith(message));
    const forwarded = t.published[0]!;
    expect(forwarded.message.routingKey).toBe('retry.1');
    expect(forwarded.headers).toEqual({
      'x-correlation-id': 'corr',
      custom: 'kept',
      'x-retry-count': 1,
      'x-last-error': 'down',
    });
  });

  it.each([
    ['garbage text', 'abc', 0],
    ['negative', -5, 0],
    ['fraction', 1.5, 0],
    ['numeric string', '1', 1],
  ])('treats a %s x-retry-count as %s', async (_label, header, expected) => {
    const seen: number[] = [];
    const t = setup({
      handler: async (m) => {
        seen.push(m.retryCount);
        return { action: 'ack' };
      },
    });
    await t.started;
    t.deliver(raw({ 'x-retry-count': header }));
    await vi.waitFor(() => expect(seen).toEqual([expected]));
  });

  it('clamps a huge x-retry-count to the tier count so the message goes to the DLQ', async () => {
    const seen: number[] = [];
    const t = setup({
      delays: [1, 2],
      handler: async (m) => {
        seen.push(m.retryCount);
        return { action: 'retry', reason: 'down' };
      },
    });
    await t.started;
    const message = raw({ 'x-retry-count': 999_999 });
    t.deliver(message);
    await vi.waitFor(() => expect(t.channel.ack).toHaveBeenCalledWith(message));
    expect(seen).toEqual([2]);
    expect(t.published[0]!.message.routingKey).toBe('dlq');
  });

  it('reports a broker-side cancel (null delivery)', async () => {
    const t = setup({ handler: async () => ({ action: 'ack' }) });
    await t.started;
    t.deliver(null);
    expect(t.onCancel).toHaveBeenCalledTimes(1);
  });
});
