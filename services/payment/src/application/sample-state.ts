import type { Clock, Logger, Metrics, UnitOfWork } from './ports.js';
import type { PaymentState } from './state.js';

const ageSeconds = (now: Date, at: Date | null): number =>
  at === null ? 0 : Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));

/** Chụp trạng thái cần đo (backlog webhook) và đẩy sang `Metrics`. Lỗi đọc chỉ được ghi log, không ném ra ngoài. */
export class SampleState {
  constructor(
    private readonly deps: { uow: UnitOfWork; metrics: Metrics; clock: Clock; log: Logger },
  ) {}

  async execute(): Promise<PaymentState | undefined> {
    try {
      const snapshot = await this.deps.uow.run(({ state }) => state.snapshot());
      const state: PaymentState = {
        webhookPending: snapshot.webhookPending,
        webhookOldestAgeSeconds: ageSeconds(this.deps.clock.now(), snapshot.webhookOldestCreatedAt),
      };
      this.deps.metrics.publishState(state);
      return state;
    } catch (error) {
      this.deps.log.warn({ err: error }, 'sampling payment state failed; skipping');
      return undefined;
    }
  }
}
