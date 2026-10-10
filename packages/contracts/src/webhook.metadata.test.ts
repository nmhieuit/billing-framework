import { describe, expect, it } from 'vitest';
import { validateChargeWebhook } from './index.js';

const base = {
  eventId: 'evt_1',
  type: 'charge.succeeded',
  createdAt: '2026-10-09T10:00:01.000Z',
  data: {
    chargeId: 'ch_1',
    reference: 'tp_1',
    amount: 1000,
    currency: 'VND',
    status: 'SUCCEEDED',
    completedAt: '2026-10-09T10:00:01.000Z',
  },
};

describe('charge webhook metadata', () => {
  it('stays valid without metadata (backward compatible)', () => {
    expect(validateChargeWebhook(base).ok).toBe(true);
  });

  it('accepts string-to-string metadata and exposes it on the typed payload', () => {
    const result = validateChargeWebhook({
      ...base,
      data: { ...base.data, metadata: { tenantId: 'acme' } },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.payload.data.metadata).toEqual({ tenantId: 'acme' });
  });

  it.each([
    ['a non-string value', { tenantId: 7 }],
    ['an array', ['x']],
    ['a value over 200 characters', { tenantId: 'x'.repeat(201) }],
    ['more than 10 keys', Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']))],
  ])('rejects metadata that is %s', (_name, metadata) => {
    expect(validateChargeWebhook({ ...base, data: { ...base.data, metadata } }).ok).toBe(false);
  });
});
