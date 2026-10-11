import { WebhookEvent } from '../domain/webhook-event.js';
import {
  noopMetrics,
  type Clock,
  type IdGenerator,
  type Metrics,
  type UnitOfWork,
} from './ports.js';

const DEFAULT_BATCH = 50;

export class CompleteDueCharges {
  private readonly metrics: Metrics;

  constructor(
    private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator; metrics?: Metrics },
  ) {
    this.metrics = deps.metrics ?? noopMetrics;
  }

  /** Hoàn tất charge đến hạn và ghi sự kiện webhook trong cùng một transaction. */
  async execute(limit = DEFAULT_BATCH): Promise<number> {
    const statuses: string[] = [];
    const completedCount = await this.deps.uow.run(async ({ charges, webhooks }) => {
      statuses.length = 0;
      const now = this.deps.clock.now();
      const due = await charges.lockDue(now, limit);
      for (const charge of due) {
        const completed = charge.complete(now);
        await charges.save(completed);
        statuses.push(completed.toProps().status);
        if (completed.toProps().scenario.webhook !== 'drop') {
          await webhooks.add(WebhookEvent.forCharge(completed, this.deps.ids.eventId(), now));
        }
      }
      return due.length;
    });
    // Ghi số đo sau khi transaction đã commit để lần thử lại không đếm trùng.
    for (const status of statuses) this.metrics.charge(status);
    return completedCount;
  }
}
