import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebhookReceiver } from './webhook-receiver.js';

let receiver: WebhookReceiver;
beforeEach(async () => {
  receiver = await WebhookReceiver.start();
});
afterEach(async () => {
  await receiver.close();
});

const post = (body: string) =>
  fetch(receiver.url, { method: 'POST', headers: { 'x-test': '1' }, body });

describe('WebhookReceiver', () => {
  it('records headers and the raw body of every request', async () => {
    await post('{"a":1}');
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]?.body).toBe('{"a":1}');
    expect(receiver.received[0]?.headers['x-test']).toBe('1');
  });

  it('answers 200 by default and follows the queued statuses first', async () => {
    receiver.respondWith(500, 503);
    expect((await post('1')).status).toBe(500);
    expect((await post('2')).status).toBe(503);
    expect((await post('3')).status).toBe(200);
  });

  it('can change the default status', async () => {
    receiver.setDefaultStatus(410);
    expect((await post('1')).status).toBe(410);
  });

  it('can delay its answer', async () => {
    receiver.setDelay(80);
    const started = Date.now();
    await post('1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });
});
