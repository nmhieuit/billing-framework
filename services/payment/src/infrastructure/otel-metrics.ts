import type { Counter, Gauge, Telemetry } from '@billing/observability';
import type { Metrics } from '../application/ports.js';
import type { PaymentState } from '../application/state.js';

export class OtelPaymentMetrics implements Metrics {
  readonly #charges: Counter;
  readonly #webhookDeliveries: Counter;
  readonly #webhookBacklog: Gauge;
  readonly #webhookOldest: Gauge;

  constructor(telemetry: Telemetry) {
    this.#charges = telemetry.counter('billing.payment.charges', 'Completed charges by status');
    this.#webhookDeliveries = telemetry.counter(
      'billing.payment.webhook_deliveries',
      'Webhook delivery attempts by result',
    );
    this.#webhookBacklog = telemetry.gauge(
      'billing.payment.webhook_backlog',
      'Webhook events still PENDING',
      '{event}',
    );
    this.#webhookOldest = telemetry.gauge(
      'billing.payment.webhook_oldest_age_seconds',
      'Age of the oldest PENDING webhook event',
      's',
    );
  }

  charge(status: string): void {
    this.#charges.add(1, { status });
  }

  webhookDelivery(result: 'delivered' | 'retrying' | 'failed'): void {
    this.#webhookDeliveries.add(1, { result });
  }

  publishState(state: PaymentState): void {
    this.#webhookBacklog.replace([{ value: state.webhookPending, attributes: {} }]);
    this.#webhookOldest.replace([{ value: state.webhookOldestAgeSeconds, attributes: {} }]);
  }
}
