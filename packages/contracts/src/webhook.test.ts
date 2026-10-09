import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  signWebhook,
  validateChargeWebhook,
  verifyWebhook,
} from './index.js';

const secret = 'whsec_test_secret';
const body = '{"eventId":"evt_1","type":"charge.succeeded"}';
const now = 1_790_000_000;

describe('signWebhook', () => {
  it('produces t=<unix>,v1=<hmac> matching an independent HMAC-SHA256', () => {
    const expected = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
    expect(signWebhook(secret, body, now)).toBe(`t=${now},v1=${expected}`);
  });
});

describe('verifyWebhook', () => {
  const header = signWebhook(secret, body, now);
  const verify = (overrides: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({ secret, body, header, nowSeconds: now, ...overrides });

  it('accepts a correct signature', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('uses a default tolerance of 300 seconds, inclusive', () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    expect(verify({ nowSeconds: now + 300 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: now - 300 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: now + 301 })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verify({ nowSeconds: now - 301 })).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('honours a custom tolerance', () => {
    expect(verify({ nowSeconds: now + 10, toleranceSeconds: 5 })).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('rejects a tampered body and a wrong secret', () => {
    expect(verify({ body: `${body} ` })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verify({ secret: 'other' })).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('reports MISMATCH, not EXPIRED, when both are wrong (no probing of the clock)', () => {
    expect(verify({ secret: 'other', nowSeconds: now + 10_000 })).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  it.each([
    undefined,
    '',
    'garbage',
    't=abc,v1=00',
    `t=${now}`,
    `v1=${'a'.repeat(64)}`,
    `t=${now},v1=${'g'.repeat(64)}`,
    `t=${now},v1=${'a'.repeat(63)}`,
  ])('rejects malformed header %j', (bad) => {
    expect(verify({ header: bad })).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('validateChargeWebhook', () => {
  const succeeded = {
    eventId: 'evt_1',
    type: 'charge.succeeded',
    createdAt: '2026-10-09T10:00:01.000Z',
    data: {
      chargeId: 'ch_1',
      reference: 'topup-1',
      amount: 150000,
      currency: 'VND',
      status: 'SUCCEEDED',
      completedAt: '2026-10-09T10:00:01.000Z',
    },
  };
  const failed = {
    ...succeeded,
    type: 'charge.failed',
    data: { ...succeeded.data, status: 'FAILED', failureCode: 'card_declined' },
  };

  it('accepts a succeeded and a failed payload', () => {
    expect(validateChargeWebhook(succeeded).ok).toBe(true);
    expect(validateChargeWebhook(failed).ok).toBe(true);
  });

  it('tolerates unknown extra fields', () => {
    expect(
      validateChargeWebhook({ ...succeeded, future: 1, data: { ...succeeded.data, x: 2 } }).ok,
    ).toBe(true);
  });

  it.each([
    ['unknown type', { ...succeeded, type: 'charge.refunded' }],
    [
      'succeeded type with FAILED status',
      { ...succeeded, data: { ...succeeded.data, status: 'FAILED' } },
    ],
    [
      'succeeded with a failureCode',
      { ...succeeded, data: { ...succeeded.data, failureCode: 'x' } },
    ],
    [
      'failed type with SUCCEEDED status',
      { ...failed, data: { ...failed.data, status: 'SUCCEEDED' } },
    ],
    [
      'failed without a failureCode',
      { ...failed, data: { ...failed.data, failureCode: undefined } },
    ],
    ['bad failureCode', { ...failed, data: { ...failed.data, failureCode: 'Bad Code' } }],
    ['zero amount', { ...succeeded, data: { ...succeeded.data, amount: 0 } }],
    ['float amount', { ...succeeded, data: { ...succeeded.data, amount: 1.5 } }],
    ['unsupported currency', { ...succeeded, data: { ...succeeded.data, currency: 'EUR' } }],
    ['missing chargeId', { ...succeeded, data: { ...succeeded.data, chargeId: undefined } }],
    ['bad timestamp', { ...succeeded, createdAt: 'yesterday' }],
  ])('rejects %s', (_name, payload) => {
    expect(validateChargeWebhook(payload).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateChargeWebhook(null).ok).toBe(false);
    expect(validateChargeWebhook('x').ok).toBe(false);
  });
});
