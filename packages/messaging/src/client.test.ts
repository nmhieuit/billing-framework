import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLog, testTopology } from './test-helpers.js';

/** Một channel giả đủ cho BrokerClient (khai báo topology, consume, publish confirm). */
class FakeChannel extends EventEmitter {
  readonly consumeCalls: string[] = [];
  readonly cancelled: string[] = [];
  closed = false;
  /** Gọi ngay sau khi consume-ok được tạo (trước khi `consume` trả về cho bên gọi). */
  onConsumeOk: (() => void) | undefined;
  checkExchange = vi.fn(async () => undefined);
  assertExchange = vi.fn(async () => undefined);
  assertQueue = vi.fn(async () => undefined);
  bindQueue = vi.fn(async () => undefined);
  prefetch = vi.fn(async () => undefined);
  ack = vi.fn();
  nack = vi.fn();
  consume = vi.fn(async (queue: string) => {
    this.consumeCalls.push(queue);
    const consumerTag = `tag-${this.consumeCalls.length}`;
    this.onConsumeOk?.();
    return { consumerTag };
  });
  cancel = vi.fn(async (tag: string) => {
    if (this.closed) throw new Error('channel closed');
    this.cancelled.push(tag);
  });
  close = vi.fn(async () => {
    this.closed = true;
  });
}

const created = vi.hoisted(() => ({
  setup: undefined as undefined | ((model: unknown) => unknown),
}));

vi.mock('amqplib', () => ({
  connect: vi.fn(
    async (_url: unknown, options: { recovery: { setup: (model: unknown) => Promise<void> } }) => {
      created.setup = options.recovery.setup;
      return Object.assign(new EventEmitter(), { close: async () => undefined });
    },
  ),
}));

const { BrokerClient } = await import('./client.js');

/** Model giả: mỗi lần createChannel ghi lại channel (consume channel đầu tiên do `plan` cấu hình). */
function fakeModel() {
  const channels: FakeChannel[] = [];
  const model = {
    createConfirmChannel: vi.fn(async () => Object.assign(new FakeChannel(), { publish: vi.fn() })),
    createChannel: vi.fn(async () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel;
    }),
  };
  return { model, channels };
}

describe('BrokerClient consumer start race (fake channels)', () => {
  beforeEach(() => {
    created.setup = undefined;
  });

  it('ends up with a live consumer when the consume channel closes right after consume-ok', async () => {
    const { model, channels } = fakeModel();
    const client = await BrokerClient.connect({
      config: { host: 'h', port: 5672, user: 'u', password: 'p', vhost: '/' },
      log: silentLog,
    });
    // Đăng ký trước khi có kết nối: consumer chỉ được bật bởi #setup.
    await client.consume({
      topology: testTopology(),
      prefetch: 1,
      handler: async () => ({ action: 'ack' }),
    });

    // createChannel đầu tiên là consume channel: broker đóng nó ngay sau consume-ok.
    const original = model.createChannel.getMockImplementation()!;
    let calls = 0;
    model.createChannel.mockImplementation(async () => {
      const channel = (await original()) as FakeChannel;
      calls += 1;
      if (calls === 1) channel.onConsumeOk = () => channel.emit('close');
      return channel;
    });

    await created.setup!(model);

    await vi.waitFor(
      () => {
        const consuming = channels.filter((c) => c.consumeCalls.length > 0);
        expect(consuming.length).toBeGreaterThanOrEqual(2);
        const last = consuming[consuming.length - 1]!;
        expect(last.cancelled).toEqual([]);
        expect(client.channelsForTesting.consume).toBe(last);
      },
      { timeout: 4000 },
    );
    // El consumer del channel cerrado fue cancelado y descartado, no quedó "running".
    const first = channels.find((c) => c.consumeCalls.length > 0)!;
    expect(first.cancelled).toEqual(['tag-1']);

    await client.close();
  });

  it('does not leave a consumer running when the client starts closing during start', async () => {
    const { model, channels } = fakeModel();
    const client = await BrokerClient.connect({
      config: { host: 'h', port: 5672, user: 'u', password: 'p', vhost: '/' },
      log: silentLog,
      stopTimeoutMs: 50,
    });
    await client.consume({
      topology: testTopology(),
      prefetch: 1,
      handler: async () => ({ action: 'ack' }),
    });

    const original = model.createChannel.getMockImplementation()!;
    model.createChannel.mockImplementation(async () => {
      const channel = (await original()) as FakeChannel;
      channel.onConsumeOk = () => {
        void client.stopConsuming();
      };
      return channel;
    });

    await created.setup!(model);

    const consuming = channels.filter((c) => c.consumeCalls.length > 0);
    expect(consuming).toHaveLength(1);
    expect(consuming[0]!.cancelled).toEqual(['tag-1']);
    await client.close();
  });
});
