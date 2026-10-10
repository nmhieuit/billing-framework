import { eventCatalog } from '@billing/contracts';
import type { ConsumerTopology } from '@billing/messaging';

export const ORDER_PAYMENTS_QUEUE = 'wallet.order-payments';

/** Topology của consumer `OrderReadyForPaymentV1`; xem spec Bước 4 mục 3. Không dùng default exchange. */
export function orderPaymentsTopology(retryDelaysSeconds: readonly number[]): ConsumerTopology {
  return {
    queue: ORDER_PAYMENTS_QUEUE,
    workExchange: 'wallet.work',
    workRoutingKey: 'order-payments',
    retryExchange: 'wallet.retry',
    retryDelaysSeconds,
    bindings: [
      { exchange: 'orders.events', routingKey: eventCatalog.OrderReadyForPaymentV1.routingKey },
    ],
  };
}
