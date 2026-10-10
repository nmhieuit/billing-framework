import { Money } from '@billing/money';
import { FakePaymentServer } from '@billing/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayChargeRequest } from '../application/ports.js';
import { HttpPaymentGateway } from './http-payment-gateway.js';

let server: FakePaymentServer;
beforeEach(async () => {
  server = await FakePaymentServer.start();
});
afterEach(async () => {
  await server.close();
});

const request: GatewayChargeRequest = {
  idempotencyKey: 'topup:acme:tp_1',
  amount: Money.of(150000, 'VND'),
  reference: 'tp_1',
  metadata: { tenantId: 'acme' },
};
const gateway = (overrides: { timeoutMs?: number; baseUrl?: string } = {}) =>
  new HttpPaymentGateway({ baseUrl: server.baseUrl, timeoutMs: 1000, ...overrides });

describe('HttpPaymentGateway', () => {
  it('posts the charge with its idempotency key and metadata, and returns the charge id', async () => {
    expect(await gateway().createCharge(request)).toEqual({
      kind: 'created',
      chargeId: 'ch_fake_1',
    });
    const [sent] = server.requests;
    expect(sent).toMatchObject({ method: 'POST', url: '/charges' });
    expect(sent?.headers['idempotency-key']).toBe('topup:acme:tp_1');
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      amount: 150000,
      currency: 'VND',
      reference: 'tp_1',
      metadata: { tenantId: 'acme' },
    });
  });

  it.each([400, 404, 422])(
    'treats %d as a rejection and surfaces the gateway message',
    async (status) => {
      server.enqueue({
        status,
        body: { error: { code: 'INVALID_REQUEST', message: 'bad amount' } },
      });
      expect(await gateway().createCharge(request)).toEqual({
        kind: 'rejected',
        status,
        message: 'bad amount',
      });
    },
  );

  it('falls back to a generic message when the rejection has no readable body', async () => {
    server.enqueue({ status: 400 });
    expect(await gateway().createCharge(request)).toEqual({
      kind: 'rejected',
      status: 400,
      message: 'HTTP 400',
    });
  });

  it.each([408, 429, 500, 502, 503])('treats %d as temporarily unavailable', async (status) => {
    server.enqueue({ status });
    expect(await gateway().createCharge(request)).toEqual({
      kind: 'unavailable',
      error: `HTTP ${status}`,
    });
  });

  it('treats a 202 without a charge id as unavailable', async () => {
    server.enqueue(
      { status: 202, body: { status: 'PENDING' } },
      { status: 202, body: { chargeId: '' } },
    );
    expect((await gateway().createCharge(request)).kind).toBe('unavailable');
    expect((await gateway().createCharge(request)).kind).toBe('unavailable');
  });

  it('treats a connection error as unavailable and never throws', async () => {
    const baseUrl = server.baseUrl;
    await server.close();
    const result = await gateway({ baseUrl }).createCharge(request);
    expect(result.kind).toBe('unavailable');
  });

  it('gives up on a gateway that is too slow', async () => {
    server.enqueue({ status: 202, body: { chargeId: 'ch_slow' }, delayMs: 500 });
    const result = await gateway({ timeoutMs: 50 }).createCharge(request);
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.error).toMatch(/abort|timeout/i);
  });
});
