import { describe, expect, it } from 'vitest';
import { decodeOrderReady } from './order-ready.decoder.js';

const valid = {
  eventId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  occurredAtUtc: '2026-10-10T10:00:00Z',
  tenantId: 'acme',
  correlationId: 'corr-1',
  orderId: '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11',
  customerId: 'cust-1',
  amount: 150000,
  currency: 'VND',
};

describe('decodeOrderReady', () => {
  it('decodes a valid event from a Buffer or a string and ignores unknown fields', () => {
    for (const body of [
      JSON.stringify(valid),
      Buffer.from(JSON.stringify({ ...valid, future: 1 })),
    ]) {
      const result = decodeOrderReady(body);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.orderId).toBe(valid.orderId);
    }
  });

  it('refuses a body that is not JSON', () => {
    expect(decodeOrderReady('{not json')).toEqual({ ok: false, reason: 'body is not valid JSON' });
  });

  it.each([
    ['a non-positive amount', { amount: 0 }],
    ['an unsupported currency', { currency: 'EUR' }],
    ['a missing tenant', { tenantId: undefined }],
    ['a non-uuid order id', { orderId: 'o-1' }],
  ])('refuses %s with a readable reason', (_name, patch) => {
    const result = decodeOrderReady(JSON.stringify({ ...valid, ...patch }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^schema validation failed: /);
  });

  it('refuses a JSON value that is not an object', () => {
    expect(decodeOrderReady('null').ok).toBe(false);
    expect(decodeOrderReady('[1]').ok).toBe(false);
  });
});
