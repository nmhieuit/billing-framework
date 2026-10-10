import { describe, expect, it } from 'vitest';
import { eventCatalog, validateEvent } from './index.js';

const common = {
  eventId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  occurredAtUtc: '2026-10-10T10:00:00Z',
  tenantId: 'acme',
  correlationId: 'corr-1',
};

const ready = {
  ...common,
  orderId: '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11',
  customerId: 'cust-1',
  amount: 150000,
  currency: 'VND',
};

const paid = {
  ...common,
  orderId: ready.orderId,
  walletTransactionId: 'tx_1',
  amount: 150000,
  currency: 'VND',
  paidAtUtc: '2026-10-10T10:00:01Z',
};

const failed = { ...common, orderId: ready.orderId, reason: 'INSUFFICIENT_FUNDS' };

describe('validateEvent', () => {
  it('accepts a valid OrderReadyForPaymentV1 and returns it typed', () => {
    const result = validateEvent('OrderReadyForPaymentV1', ready);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.amount).toBe(150000);
  });

  it('accepts valid OrderPaidV1 and OrderPaymentFailedV1', () => {
    expect(validateEvent('OrderPaidV1', paid).ok).toBe(true);
    expect(validateEvent('OrderPaymentFailedV1', failed).ok).toBe(true);
  });

  it.each(['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'])(
    'accepts the failure reason %s',
    (reason) => {
      expect(validateEvent('OrderPaymentFailedV1', { ...failed, reason }).ok).toBe(true);
    },
  );

  it('rejects an unknown failure reason', () => {
    expect(validateEvent('OrderPaymentFailedV1', { ...failed, reason: 'BECAUSE' }).ok).toBe(false);
  });

  it('tolerates unknown extra fields (tolerant reader)', () => {
    expect(validateEvent('OrderReadyForPaymentV1', { ...ready, futureField: { x: 1 } }).ok).toBe(
      true,
    );
    expect(validateEvent('OrderPaidV1', { ...paid, futureField: 'x' }).ok).toBe(true);
  });

  it.each([
    ['float amount', { amount: 10.5 }],
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }],
    ['string amount', { amount: '100' }],
    ['unsupported currency', { currency: 'EUR' }],
    ['missing orderId', { orderId: undefined }],
    ['non-uuid orderId', { orderId: 'o-1' }],
    ['missing customerId', { customerId: undefined }],
    ['non-uuid eventId', { eventId: 'abc' }],
    ['bad timestamp', { occurredAtUtc: 'yesterday' }],
    ['missing tenantId', { tenantId: undefined }],
    ['empty tenantId', { tenantId: '' }],
    ['missing correlationId', { correlationId: undefined }],
  ])('rejects OrderReadyForPaymentV1 with %s', (_name, patch) => {
    expect(validateEvent('OrderReadyForPaymentV1', { ...ready, ...patch }).ok).toBe(false);
  });

  it.each([
    ['missing walletTransactionId', { walletTransactionId: undefined }],
    ['missing paidAtUtc', { paidAtUtc: undefined }],
    ['bad paidAtUtc', { paidAtUtc: 'later' }],
    ['float amount', { amount: 1.5 }],
  ])('rejects OrderPaidV1 with %s', (_name, patch) => {
    expect(validateEvent('OrderPaidV1', { ...paid, ...patch }).ok).toBe(false);
  });

  it('reports readable errors', () => {
    const result = validateEvent('OrderReadyForPaymentV1', { ...ready, amount: 0 });
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('/amount')] });
  });

  it('rejects non-object input', () => {
    expect(validateEvent('OrderPaidV1', null).ok).toBe(false);
    expect(validateEvent('OrderPaidV1', 'x').ok).toBe(false);
    expect(validateEvent('OrderPaidV1', [paid]).ok).toBe(false);
  });
});

describe('eventCatalog', () => {
  it('maps every event to its routing key and schema file', () => {
    expect(
      Object.entries(eventCatalog).map(([name, e]) => [name, e.routingKey, e.schemaFile]),
    ).toEqual([
      [
        'OrderReadyForPaymentV1',
        'order-ready-for-payment.v1',
        'OrderReadyForPayment.v1.schema.json',
      ],
      ['OrderPaidV1', 'order-paid.v1', 'OrderPaid.v1.schema.json'],
      ['OrderPaymentFailedV1', 'order-payment-failed.v1', 'OrderPaymentFailed.v1.schema.json'],
    ]);
  });
});
