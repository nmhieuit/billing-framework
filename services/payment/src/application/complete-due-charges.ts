import { WebhookEvent } from '../domain/webhook-event.js';
import type { Clock, IdGenerator, UnitOfWork } from './ports.js';

const DEFAULT_BATCH = 50;

export class CompleteDueCharges {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }) {}

  /** Hoàn tất charge đến hạn và ghi sự kiện webhook trong cùng một transaction. */
  async execute(limit = DEFAULT_BATCH): Promise<number> {
    return this.deps.uow.run(async ({ charges, webhooks }) => {
      const now = this.deps.clock.now();
      const due = await charges.lockDue(now, limit);
      for (const charge of due) {
        const completed = charge.complete(now);
        await charges.save(completed);
        if (completed.toProps().scenario.webhook !== 'drop') {
          await webhooks.add(WebhookEvent.forCharge(completed, this.deps.ids.eventId(), now));
        }
      }
      return due.length;
    });
  }
}
