import type { Counter, Gauge, Telemetry } from '@billing/observability';
import type { ConsumerResult, Metrics } from '../application/ports.js';
import type { RetentionReport } from '../application/retention.js';
import type { WalletState } from '../application/state.js';

/** Hàng đợi chết của consumer order; nhãn `queue` của gauge DLQ. */
export const ORDER_DLQ_LABEL = 'wallet.order-payments.dlq';

const CONSUMER_RESULTS: readonly ConsumerResult[] = [
  'processed',
  'retried',
  'dead_lettered',
  'rejected',
];

export class OtelWalletMetrics implements Metrics {
  readonly #orderPayments: Counter;
  readonly #consumerMessages: Counter;
  readonly #topups: Counter;
  readonly #reconciliationRuns: Counter;
  readonly #dlqDepth: Gauge;
  readonly #outboxPending: Gauge;
  readonly #outboxOldest: Gauge;
  readonly #topupsBacklog: Gauge;
  readonly #topupsOldest: Gauge;
  readonly #openItems: Gauge;
  readonly #oldestOpenItem: Gauge;
  readonly #lastSuccess: Gauge;
  readonly #retentionRows: Counter;
  readonly #retentionLastSuccess: Gauge;
  readonly #now: () => Date;

  constructor(telemetry: Telemetry, now: () => Date = () => new Date()) {
    this.#now = now;
    this.#orderPayments = telemetry.counter('billing.order_payments', 'Order payments by outcome');
    this.#consumerMessages = telemetry.counter(
      'billing.consumer.messages',
      'Consumed messages by result',
    );
    this.#topups = telemetry.counter('billing.topups', 'Top-up events by stage and outcome');
    this.#reconciliationRuns = telemetry.counter(
      'billing.reconciliation.runs',
      'Reconciliation runs by status',
    );
    this.#dlqDepth = telemetry.gauge(
      'billing.dlq.depth',
      'Messages waiting in the dead-letter queue',
      '{message}',
    );
    this.#outboxPending = telemetry.gauge(
      'billing.outbox.pending',
      'Outbox rows not yet sent',
      '{message}',
    );
    this.#outboxOldest = telemetry.gauge(
      'billing.outbox.oldest_age_seconds',
      'Age of the oldest unsent outbox row',
      's',
    );
    this.#topupsBacklog = telemetry.gauge(
      'billing.topups.requested_backlog',
      'Top-ups still REQUESTED',
      '{topup}',
    );
    this.#topupsOldest = telemetry.gauge(
      'billing.topups.oldest_requested_age_seconds',
      'Age of the oldest REQUESTED top-up',
      's',
    );
    this.#openItems = telemetry.gauge(
      'billing.reconciliation.open_items',
      'Open reconciliation cases by kind',
      '{case}',
    );
    this.#oldestOpenItem = telemetry.gauge(
      'billing.reconciliation.oldest_open_item_age_seconds',
      'Age of the oldest open reconciliation case',
      's',
    );
    this.#lastSuccess = telemetry.gauge(
      'billing.reconciliation.last_success_age_seconds',
      'Seconds since the last completed reconciliation run',
      's',
    );
    this.#retentionRows = telemetry.counter(
      'billing.retention.rows',
      'Rows deleted (or that would be deleted in dry-run) by retention',
    );
    this.#retentionLastSuccess = telemetry.gauge(
      'billing.retention.last_success_timestamp_seconds',
      'Unix time of the last retention run that finished without errors',
      's',
    );
  }

  prime(tenants: readonly string[]): void {
    for (const tenant of tenants) {
      this.#orderPayments.add(0, { tenant, outcome: 'paid' });
      for (const status of ['COMPLETED', 'FAILED']) {
        this.#reconciliationRuns.add(0, { tenant, status });
      }
    }
    for (const result of CONSUMER_RESULTS) {
      this.#consumerMessages.add(0, { result });
    }
  }

  orderPayment(tenant: string, outcome: string): void {
    this.#orderPayments.add(1, { tenant, outcome });
  }

  consumerMessage(result: ConsumerResult): void {
    this.#consumerMessages.add(1, { result });
  }

  topup(tenant: string, stage: string, outcome: string): void {
    this.#topups.add(1, { tenant, stage, outcome });
  }

  reconciliationRun(tenant: string, status: string): void {
    this.#reconciliationRuns.add(1, { tenant, status });
  }

  retentionRun(report: RetentionReport): void {
    const mode = report.dryRun ? 'would_delete' : 'deleted';
    for (const row of report.rows) {
      if (row.count > 0) {
        this.#retentionRows.add(row.count, { tenant: row.tenant, table: row.table, mode });
      }
    }
    // Lượt có lỗi không làm mới mốc thành công để cảnh báo "lâu không dọn" vẫn kích hoạt.
    if (report.errors === 0) {
      this.#retentionLastSuccess.replace([{ value: Math.floor(this.#now().getTime() / 1000) }]);
    }
  }

  publishState(state: WalletState): void {
    this.#dlqDepth.replace(
      state.dlqDepth === null
        ? []
        : [{ value: state.dlqDepth, attributes: { queue: ORDER_DLQ_LABEL } }],
    );
    const perTenant = (pick: (t: WalletState['tenants'][number]) => number | null) =>
      state.tenants.flatMap((t) => {
        const value = pick(t);
        return value === null ? [] : [{ value, attributes: { tenant: t.tenant } }];
      });
    this.#outboxPending.replace(perTenant((t) => t.outboxPending));
    this.#outboxOldest.replace(perTenant((t) => t.outboxOldestAgeSeconds));
    this.#topupsBacklog.replace(perTenant((t) => t.topupsRequestedBacklog));
    this.#topupsOldest.replace(perTenant((t) => t.topupsOldestRequestedAgeSeconds));
    this.#oldestOpenItem.replace(perTenant((t) => t.oldestOpenItemAgeSeconds));
    this.#lastSuccess.replace(perTenant((t) => t.lastReconciliationSuccessAgeSeconds));
    this.#openItems.replace(
      state.tenants.flatMap((t) =>
        Object.entries(t.openItemsByKind).map(([kind, value]) => ({
          value,
          attributes: { tenant: t.tenant, kind },
        })),
      ),
    );
  }
}
