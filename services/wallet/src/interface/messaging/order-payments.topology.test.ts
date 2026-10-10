import { describe, expect, it } from 'vitest';
import { ORDER_PAYMENTS_QUEUE, orderPaymentsTopology } from './order-payments.topology.js';

describe('orderPaymentsTopology', () => {
  it('binds the work queue to orders.events with the routing key of OrderReadyForPaymentV1 and passes the retry tiers', () => {
    expect(orderPaymentsTopology([5, 30, 120])).toEqual({
      queue: 'wallet.order-payments',
      workExchange: 'wallet.work',
      workRoutingKey: 'order-payments',
      retryExchange: 'wallet.retry',
      retryDelaysSeconds: [5, 30, 120],
      bindings: [{ exchange: 'orders.events', routingKey: 'order-ready-for-payment.v1' }],
    });
    expect(ORDER_PAYMENTS_QUEUE).toBe('wallet.order-payments');
  });
});
