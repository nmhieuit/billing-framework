import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ConfirmPublisher, PUBLISH_ID_HEADER } from './publisher.js';
import type { OutgoingMessage } from './types.js';

type Confirm = (error: Error | null) => void;

interface Sent {
  routingKey: string;
  headers: Record<string, unknown>;
  confirm: Confirm;
}

/** Channel giả: ghi lại từng lần publish để test tự quyết định lúc nào confirm / return. */
class FakeChannel extends EventEmitter {
  readonly sent: Sent[] = [];
  publishError: Error | undefined;

  publish(
    _exchange: string,
    routingKey: string,
    _content: Buffer,
    options: { headers: Record<string, unknown> },
    confirm: Confirm,
  ): boolean {
    if (this.publishError) throw this.publishError;
    this.sent.push({ routingKey, headers: options.headers, confirm });
    return true;
  }

  returnMessage(sent: Sent): void {
    this.emit('return', { properties: { headers: sent.headers } });
  }
}

const message = (routingKey: string, messageId = 'same-id'): OutgoingMessage => ({
  exchange: 'billing.events',
  routingKey,
  messageId,
  type: 'OrderPaidV1',
  correlationId: 'c',
  body: '{}',
});

function attached(options?: { timeoutMs?: number }): {
  publisher: ConfirmPublisher;
  channel: FakeChannel;
} {
  const publisher = new ConfirmPublisher(options);
  const channel = new FakeChannel();
  publisher.attach(channel as never);
  return { publisher, channel };
}

describe('ConfirmPublisher (fake channel)', () => {
  it('fails when the broker never confirms within the timeout', async () => {
    const { publisher } = attached({ timeoutMs: 20 });
    const result = await publisher.publish(message('a'));
    expect(result).toEqual({ kind: 'failed', error: 'no confirm within 20 ms' });
  });

  it('fails (never throws) when the channel throws synchronously', async () => {
    const { publisher, channel } = attached();
    channel.publishError = new Error('channel closed');
    expect(await publisher.publish(message('a'))).toEqual({
      kind: 'failed',
      error: 'channel closed',
    });
  });

  it('fails when not attached', async () => {
    expect((await new ConfirmPublisher().publish(message('a'))).kind).toBe('failed');
  });

  it('matches returns to the publish that caused them even when messageId is shared', async () => {
    const { publisher, channel } = attached();
    const routable = publisher.publish(message('bound'));
    const unroutable = publisher.publish(message('unbound'));
    const [a, b] = channel.sent as [Sent, Sent];
    channel.returnMessage(b);
    // Xác nhận theo thứ tự ngược để chắc chắn không phụ thuộc thứ tự.
    b.confirm(null);
    a.confirm(null);
    expect(await routable).toEqual({ kind: 'delivered' });
    expect(await unroutable).toEqual({ kind: 'unroutable' });
  });

  it('ignores a late return for a publish that already timed out', async () => {
    const { publisher, channel } = attached({ timeoutMs: 20 });
    expect((await publisher.publish(message('a'))).kind).toBe('failed');
    channel.returnMessage(channel.sent[0] as Sent);

    const next = publisher.publish(message('a'));
    (channel.sent[1] as Sent).confirm(null);
    expect(await next).toEqual({ kind: 'delivered' });
  });

  it('always overwrites a caller-supplied x-publish-id', async () => {
    const { publisher, channel } = attached();
    const result = publisher.publish(message('a'), { [PUBLISH_ID_HEADER]: 'forged', extra: 1 });
    const sent = channel.sent[0] as Sent;
    expect(sent.headers[PUBLISH_ID_HEADER]).not.toBe('forged');
    expect(sent.headers['extra']).toBe(1);
    sent.confirm(null);
    await result;
  });
});
