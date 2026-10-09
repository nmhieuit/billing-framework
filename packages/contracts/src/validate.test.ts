import { describe, expect, it } from 'vitest';
import { validateMessage } from './index.js';

const base = {
  messageId: '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01',
  occurredAt: '2026-10-09T10:00:00Z',
  correlationId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  causationId: '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01',
  tenantId: 'tenant-1',
};

const readyForPayment = {
  ...base,
  type: 'orders.order-ready-for-payment.v1',
  data: { orderId: 'o-1', customerId: 'c-1', amount: 150000, currency: 'VND' },
};

describe('validateMessage', () => {
  it('accepts a valid order-ready-for-payment message', () => {
    const result = validateMessage(readyForPayment);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.type).toBe('orders.order-ready-for-payment.v1');
  });

  it('accepts a valid order-paid message', () => {
    const result = validateMessage({
      ...base,
      type: 'billing.order-paid.v1',
      data: { orderId: 'o-1', walletTransactionId: 'tx-1', paidAt: '2026-10-09T10:00:01Z' },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts order-payment-failed with every documented reason', () => {
    for (const reason of [
      'INSUFFICIENT_FUNDS',
      'WALLET_NOT_FOUND',
      'CURRENCY_MISMATCH',
      'CONFLICT',
    ]) {
      const result = validateMessage({
        ...base,
        type: 'billing.order-payment-failed.v1',
        data: { orderId: 'o-1', reason },
      });
      expect(result.ok, reason).toBe(true);
    }
  });

  it('rejects an unknown failure reason', () => {
    const result = validateMessage({
      ...base,
      type: 'billing.order-payment-failed.v1',
      data: { orderId: 'o-1', reason: 'BECAUSE' },
    });
    expect(result.ok).toBe(false);
  });

  it('tolerates unknown extra fields (tolerant reader)', () => {
    const result = validateMessage({
      ...readyForPayment,
      futureEnvelopeField: true,
      data: { ...readyForPayment.data, futureField: 'x' },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['float amount', { amount: 10.5 }],
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }],
    ['string amount', { amount: '100' }],
    ['unsupported currency', { currency: 'EUR' }],
    ['missing orderId', { orderId: undefined }],
  ])('rejects %s', (_name, patch) => {
    const result = validateMessage({
      ...readyForPayment,
      data: { ...readyForPayment.data, ...patch },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown message type', () => {
    const result = validateMessage({ ...base, type: 'orders.something-else.v1', data: {} });
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('UNKNOWN_TYPE')] });
  });

  it.each([
    ['non-uuid messageId', { messageId: 'abc' }],
    ['bad timestamp', { occurredAt: 'yesterday' }],
    ['missing tenantId', { tenantId: undefined }],
    ['missing causationId', { causationId: undefined }],
    ['type without version', { type: 'orders.order-ready-for-payment' }],
  ])('rejects envelope with %s', (_name, patch) => {
    const result = validateMessage({ ...readyForPayment, ...patch });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateMessage(null).ok).toBe(false);
    expect(validateMessage('x').ok).toBe(false);
  });
});
