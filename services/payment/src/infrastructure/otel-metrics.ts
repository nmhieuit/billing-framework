import type { Counter, Gauge, Telemetry } from '@billing/observability';
import type { Metrics } from '../application/ports.js';
import type { RetentionReport } from '../application/retention.js';
import type { PaymentState } from '../application/state.js';

export class OtelPaymentMetrics implements Metrics {
  readonly #charges: Counter;
  readonly #webhookDeliveries: Counter;
  readonly #webhookBacklog: Gauge;
  readonly #webhookOldest: Gauge;
  readonly #retentionRows: Counter;
  readonly #retentionLastSuccess: Gauge;
  readonly #now: () => Date;

  constructor(telemetry: Telemetry, now: () => Date = () => new Date()) {
    this.#now = now;
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

  charge(status: string): void {
    this.#charges.add(1, { status });
  }

  webhookDelivery(result: 'delivered' | 'retrying' | 'failed'): void {
    this.#webhookDeliveries.add(1, { result });
  }

  retentionRun(report: RetentionReport): void {
    const mode = report.dryRun ? 'would_delete' : 'deleted';
    for (const row of report.rows) {
      if (row.count > 0) {
        this.#retentionRows.add(row.count, { table: row.table, mode });
      }
    }
    // Lượt có lỗi không làm mới mốc thành công để cảnh báo "lâu không dọn" vẫn kích hoạt.
    if (report.errors === 0) {
      this.#retentionLastSuccess.replace([{ value: Math.floor(this.#now().getTime() / 1000) }]);
    }
  }

  publishState(state: PaymentState | null): void {
    if (state === null) {
      // Không lấy mẫu được: bỏ điểm dữ liệu để gauge ngừng xuất, không để số cũ mang dấu thời gian mới.
      this.#webhookBacklog.replace([]);
      this.#webhookOldest.replace([]);
      return;
    }
    this.#webhookBacklog.replace([{ value: state.webhookPending, attributes: {} }]);
    this.#webhookOldest.replace([{ value: state.webhookOldestAgeSeconds, attributes: {} }]);
  }
}
