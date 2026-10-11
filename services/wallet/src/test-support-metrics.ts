import type { ConsumerResult, Metrics } from './application/ports.js';
import type { RetentionReport } from './application/retention.js';
import type { WalletState } from './application/state.js';

/** Ghi lại mọi lời gọi để test kiểm tra. */
export class RecordingMetrics implements Metrics {
  readonly calls: Array<[method: string, ...args: unknown[]]> = [];
  prime(tenants: readonly string[]): void {
    this.calls.push(['prime', tenants]);
  }
  orderPayment(tenant: string, outcome: string): void {
    this.calls.push(['orderPayment', tenant, outcome]);
  }
  consumerMessage(result: ConsumerResult): void {
    this.calls.push(['consumerMessage', result]);
  }
  topup(tenant: string, stage: string, outcome: string): void {
    this.calls.push(['topup', tenant, stage, outcome]);
  }
  reconciliationRun(tenant: string, status: string): void {
    this.calls.push(['reconciliationRun', tenant, status]);
  }
  publishState(state: WalletState): void {
    this.calls.push(['publishState', state]);
  }
  retentionRun(report: RetentionReport): void {
    this.calls.push(['retentionRun', report]);
  }
}
