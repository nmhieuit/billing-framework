import { validateChargeWebhook, verifyWebhook } from '@billing/contracts';
import { Money } from '@billing/money';
import { WebhookReceiver } from '@billing/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Charge } from '../domain/charge.js';
import { DEFAULT_SCENARIO } from '../domain/scenario.js';
import { WebhookEvent } from '../domain/webhook-event.js';
import { HttpWebhookSender } from './http-webhook-sender.js';

const secret = 'test-secret';
const now = new Date('2026-10-09T10:00:00.000Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const makeEvent = () =>
  WebhookEvent.forCharge(
    Charge.create({
      id: 'ch_1',
      reference: 'topup-1',
      amount: Money.of(150000, 'VND'),
      scenario: DEFAULT_SCENARIO,
      now,
    }).complete(now),
    'evt_1',
    now,
  );

let receiver: WebhookReceiver;
beforeEach(async () => {
  receiver = await WebhookReceiver.start();
});
afterEach(async () => {
  await receiver.close();
});

const sender = (overrides: Partial<ConstructorParameters<typeof HttpWebhookSender>[0]> = {}) =>
  new HttpWebhookSender({ url: receiver.url, secret, timeoutMs: 1000, ...overrides });

describe('HttpWebhookSender', () => {
  it('posts the raw payload with a verifiable signature and the event id', async () => {
    const event = makeEvent();
    expect(await sender().send(event, now)).toEqual({ ok: true, statusCode: 200 });

    const [request] = receiver.received;
    expect(request?.body).toBe(event.toProps().payload);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['x-webhook-event-id']).toBe('evt_1');
    expect(
      verifyWebhook({
        secret,
        body: request?.body ?? '',
        header: request?.headers['x-signature'] as string,
        nowSeconds: seconds(now),
      }),
    ).toEqual({ ok: true });
    expect(validateChargeWebhook(JSON.parse(request?.body ?? '')).ok).toBe(true);
  });

  it('signs with the timestamp it is given, so every retry carries a fresh signature', async () => {
    const later = new Date(now.getTime() + 60_000);
    await sender().send(makeEvent(), later);
    const header = receiver.received[0]?.headers['x-signature'] as string;
    expect(header.startsWith(`t=${seconds(later)},`)).toBe(true);
  });

  it('reports a non-2xx answer as a failure with its status code', async () => {
    receiver.respondWith(500);
    expect(await sender().send(makeEvent(), now)).toEqual({
      ok: false,
      statusCode: 500,
      error: 'HTTP 500',
    });
  });

  it('does not follow redirects', async () => {
    receiver.respondWith(302);
    expect(await sender().send(makeEvent(), now)).toMatchObject({ ok: false, statusCode: 302 });
    expect(receiver.received).toHaveLength(1);
  });

  it('reports a connection error without throwing', async () => {
    await receiver.close();
    const result = await sender().send(makeEvent(), now);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('gives up on a receiver that is too slow', async () => {
    receiver.setDelay(500);
    const result = await sender({ timeoutMs: 50 }).send(makeEvent(), now);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort|timeout/i);
  });
});
