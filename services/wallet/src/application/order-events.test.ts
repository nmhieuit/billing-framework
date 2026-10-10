import { validateEvent } from '@billing/contracts';
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { orderPaidMessage, orderPaymentFailedMessage } from './order-events.js';

const ctx = {
  tenantId: 'acme',
  correlationId: 'corr-1',
  eventId: '00000000-0000-4000-8000-000000000001',
  now: new Date('2026-10-10T10:00:00.000Z'),
};
const orderId = '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11';

describe('order events', () => {
  it('builds an OrderPaidV1 outbox message that satisfies the published schema', () => {
    const message = orderPaidMessage(ctx, {
      orderId,
      walletTransactionId: 'tx_1',
      amount: Money.of(150000, 'VND'),
      paidAt: new Date('2026-10-10T09:59:59.000Z'),
    });
    expect(message).toMatchObject({
      id: ctx.eventId,
      eventType: 'OrderPaidV1',
      routingKey: 'order-paid.v1',
      correlationId: 'corr-1',
      createdAt: ctx.now,
    });
    const payload = JSON.parse(message.payload) as unknown;
    expect(validateEvent('OrderPaidV1', payload).ok).toBe(true);
    expect(payload).toMatchObject({
      eventId: ctx.eventId,
      occurredAtUtc: '2026-10-10T10:00:00.000Z',
      tenantId: 'acme',
      orderId,
      walletTransactionId: 'tx_1',
      amount: 150000,
      currency: 'VND',
      paidAtUtc: '2026-10-10T09:59:59.000Z',
    });
  });

  it.each(['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'] as const)(
    'builds a valid OrderPaymentFailedV1 for %s',
    (reason) => {
      const message = orderPaymentFailedMessage(ctx, { orderId, reason });
      expect(message).toMatchObject({
        eventType: 'OrderPaymentFailedV1',
        routingKey: 'order-payment-failed.v1',
      });
      const result = validateEvent('OrderPaymentFailedV1', JSON.parse(message.payload));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.reason).toBe(reason);
    },
  );
});
