import { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Charge } from '../../domain/charge.js';
import { parseScenario } from '../../domain/scenario.js';
import { WebhookEvent } from '../../domain/webhook-event.js';
import { createHarness, resetTables, type Harness } from '../../test-support.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
});

const snapshot = () => h.uow.run(({ state }) => state.snapshot());
const t0 = new Date('2026-10-09T10:00:00.000Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

/** Tạo một charge đã xong cùng sự kiện webhook PENDING có `created_at` cho trước. */
async function addEvent(n: number, createdAt: Date): Promise<WebhookEvent> {
  const pending = Charge.create({
    id: `ch_${n}`,
    reference: `ref-${n}`,
    amount: Money.of(1000, 'VND'),
    scenario: parseScenario(undefined),
    now: createdAt,
  });
  const done = pending.complete(createdAt);
  const event = WebhookEvent.forCharge(done, `evt_${n}`, createdAt);
  await h.uow.run(async ({ charges, webhooks }) => {
    await charges.insert(pending);
    await charges.save(done);
    await webhooks.add(event);
  });
  return event;
}

describe('KyselyStateRepository', () => {
  it('reports zero and null when no webhook is pending', async () => {
    expect(await snapshot()).toEqual({ webhookPending: 0, webhookOldestCreatedAt: null });
  });

  it('counts only PENDING events and reports the oldest created_at', async () => {
    await addEvent(1, at(30));
    const delivered = await addEvent(2, at(10));
    const failed = await addEvent(3, at(5));
    await addEvent(4, at(20));
    await h.uow.run(({ webhooks }) => webhooks.save(delivered.recordSuccess(at(100))));
    await h.uow.run(({ webhooks }) => webhooks.save(failed.recordFailure(at(100), [])));

    expect(await snapshot()).toEqual({ webhookPending: 2, webhookOldestCreatedAt: at(20) });
  });
});
