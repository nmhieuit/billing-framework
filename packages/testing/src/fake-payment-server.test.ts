import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentServer } from './fake-payment-server.js';

let server: FakePaymentServer;
beforeEach(async () => {
  server = await FakePaymentServer.start();
});
afterEach(async () => {
  await server.close();
});

const post = (body: object) =>
  fetch(`${server.baseUrl}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    body: JSON.stringify(body),
  });

describe('FakePaymentServer', () => {
  it('records requests and answers 202 with a numbered charge id by default', async () => {
    const first = await post({ a: 1 });
    const second = await post({ a: 2 });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ chargeId: 'ch_fake_1', status: 'PENDING' });
    expect(await second.json()).toEqual({ chargeId: 'ch_fake_2', status: 'PENDING' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({ method: 'POST', url: '/charges', body: '{"a":1}' });
    expect(server.requests[0]?.headers['idempotency-key']).toBe('k1');
  });

  it('plays queued responses first, then falls back', async () => {
    server.enqueue(
      { status: 500 },
      { status: 422, body: { error: { code: 'X', message: 'nope' } } },
    );
    expect((await post({})).status).toBe(500);
    const second = await post({});
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual({ error: { code: 'X', message: 'nope' } });
    expect((await post({})).status).toBe(202);
  });

  it('supports a custom fallback and delayed answers', async () => {
    server.setFallback((n) => ({ status: 202, body: { chargeId: `custom_${n}` }, delayMs: 60 }));
    const started = Date.now();
    const res = await post({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(await res.json()).toEqual({ chargeId: 'custom_1' });
  });

  it('passes the request to the fallback so a test can answer by URL', async () => {
    server.setFallback((_number, request) => ({ status: 200, body: { url: request.url } }));
    const response = await fetch(`${server.baseUrl}/settlements?date=2026-10-10`);
    expect(await response.json()).toEqual({ url: '/settlements?date=2026-10-10' });
  });
});
