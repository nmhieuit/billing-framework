import type { Metrics } from './application/ports.js';
import type { PaymentState } from './application/state.js';

/** Ghi lại mọi lời gọi để test kiểm tra. */
export class RecordingMetrics implements Metrics {
  readonly calls: Array<[method: string, ...args: unknown[]]> = [];
  charge(status: string): void {
    this.calls.push(['charge', status]);
  }
  webhookDelivery(result: 'delivered' | 'retrying' | 'failed'): void {
    this.calls.push(['webhookDelivery', result]);
  }
  publishState(state: PaymentState): void {
    this.calls.push(['publishState', state]);
  }
}
