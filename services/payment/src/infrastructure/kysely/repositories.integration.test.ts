import { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import { Charge } from '../../domain/charge.js';
import { parseScenario } from '../../domain/scenario.js';
import { WebhookEvent } from '../../domain/webhook-event.js';
import { createHarness, resetTables, type Harness } from '../../test-support.js';

const t0 = new Date('2026-10-09T10:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

function makeCharge(
  id: string,
  options: { simulate?: string; now?: Date; amount?: number; currency?: 'VND' | 'USD' } = {},
): Charge {
  return Charge.create({
    id,
    reference: `ref-${id}`,
    amount: Money.of(options.amount ?? 1000, options.currency ?? 'VND'),
    scenario: parseScenario(options.simulate),
    now: options.now ?? t0,
  });
}

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

describe('KyselyChargeRepository', () => {
  it('round-trips a charge including milliseconds, a bigint amount and the scenario', async () => {
    const charge = makeCharge('ch_a', {
      amount: Number.MAX_SAFE_INTEGER,
      currency: 'USD',
      now: new Date('2026-10-09T10:00:00.001Z'),
      simulate: 'fail=card_declined,delay=2,webhook=duplicate',
    });
    await h.uow.run(({ charges }) => charges.insert(charge));
    const loaded = await h.uow.run(({ charges }) => charges.findById('ch_a'));
    expect(loaded?.toProps()).toEqual(charge.toProps());
  });

  it('returns null for an unknown id', async () => {
    expect(await h.uow.run(({ charges }) => charges.findById('nope'))).toBeNull();
  });

  it('lockDue() returns only due PENDING charges, ordered by (due_at, id), honouring the limit', async () => {
    await h.uow.run(async ({ charges }) => {
      await charges.insert(makeCharge('ch_c', { simulate: 'delay=10' }));
      await charges.insert(makeCharge('ch_b'));
      await charges.insert(makeCharge('ch_a'));
      const done = makeCharge('ch_d');
      await charges.insert(done);
      await charges.save(done.complete(t0));
    });
    const ids = (cs: Charge[]) => cs.map((c) => c.toProps().id);
    expect(ids(await h.uow.run(({ charges }) => charges.lockDue(plus(5), 10)))).toEqual([
      'ch_a',
      'ch_b',
    ]);
    expect(ids(await h.uow.run(({ charges }) => charges.lockDue(plus(5), 1)))).toEqual(['ch_a']);
    expect(ids(await h.uow.run(({ charges }) => charges.lockDue(plus(10), 10)))).toEqual([
      'ch_a',
      'ch_b',
      'ch_c',
    ]);
  });

  it('lockDue() skips rows another open transaction already holds (READPAST)', async () => {
    await h.uow.run(async ({ charges }) => {
      await charges.insert(makeCharge('ch_a'));
      await charges.insert(makeCharge('ch_b'));
    });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: (ids: string[]) => void;
    const lockedIds = new Promise<string[]>((resolve) => (locked = resolve));

    const first = h.uow.run(async ({ charges }) => {
      const rows = await charges.lockDue(t0, 1);
      locked(rows.map((r) => r.toProps().id));
      await hold;
    });
    expect(await lockedIds).toEqual(['ch_a']);

    const second = await h.uow.run(({ charges }) => charges.lockDue(t0, 1));
    expect(second.map((r) => r.toProps().id)).toEqual(['ch_b']);

    release();
    await first;
  });

  it('save() persists completion', async () => {
    const charge = makeCharge('ch_a', { simulate: 'fail=card_declined' });
    await h.uow.run(({ charges }) => charges.insert(charge));
    await h.uow.run(({ charges }) => charges.save(charge.complete(plus(1))));
    const loaded = await h.uow.run(({ charges }) => charges.findById('ch_a'));
    expect(loaded?.toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
      completedAt: plus(1),
    });
  });
});

describe('KyselyIdempotencyStore', () => {
  const record = (key: string, chargeId: string) => ({
    key,
    requestHash: 'h'.repeat(64),
    responseStatus: 202,
    responseBody: '{"chargeId":"x"}',
    chargeId,
    createdAt: new Date('2026-10-09T10:00:00.123Z'),
  });

  it('stores and finds a response, and returns null for an unknown key', async () => {
    await h.uow.run(async ({ charges, idempotency }) => {
      await charges.insert(makeCharge('ch_a'));
      await idempotency.save(record('k1', 'ch_a'));
    });
    expect(await h.uow.run(({ idempotency }) => idempotency.find('k1'))).toEqual(
      record('k1', 'ch_a'),
    );
    expect(await h.uow.run(({ idempotency }) => idempotency.find('k2'))).toBeNull();
  });

  it('throws DuplicateKeyError when the key already exists', async () => {
    await h.uow.run(async ({ charges, idempotency }) => {
      await charges.insert(makeCharge('ch_a'));
      await idempotency.save(record('k1', 'ch_a'));
    });
    const again = h.uow.run(({ idempotency }) => idempotency.save(record('k1', 'ch_a')));
    await expect(again).rejects.toBeInstanceOf(DuplicateKeyError);
  });
});

describe('KyselyWebhookOutbox', () => {
  async function seedEvent(): Promise<WebhookEvent> {
    const done = makeCharge('ch_a').complete(t0);
    const event = WebhookEvent.forCharge(done, 'evt_1', t0);
    await h.uow.run(async ({ charges, webhooks }) => {
      await charges.insert(makeCharge('ch_a'));
      await charges.save(done);
      await webhooks.add(event);
    });
    return event;
  }

  it('round-trips an event through lockDue()', async () => {
    const event = await seedEvent();
    const due = await h.uow.run(({ webhooks }) => webhooks.lockDue(t0, 10));
    expect(due.map((e) => e.toProps())).toEqual([event.toProps()]);
  });

  it('lockDue() ignores events whose time has not come, and non-PENDING events', async () => {
    const event = await seedEvent();
    expect(
      await h.uow.run(({ webhooks }) => webhooks.lockDue(new Date(t0.getTime() - 1), 10)),
    ).toEqual([]);
    await h.uow.run(({ webhooks }) => webhooks.save(event.recordSuccess(plus(1))));
    expect(await h.uow.run(({ webhooks }) => webhooks.lockDue(plus(100), 10))).toEqual([]);
  });

  it('save() persists the lifecycle and recordAttempt() keeps a truncated error', async () => {
    const event = await seedEvent();
    const failed = event.recordFailure(plus(1), [5]);
    await h.uow.run(async ({ webhooks }) => {
      await webhooks.save(failed);
      await webhooks.recordAttempt({
        eventId: 'evt_1',
        attemptNo: 1,
        attemptedAt: plus(1),
        statusCode: 500,
        error: 'x'.repeat(600),
      });
    });
    const rows = await h.db.selectFrom('webhook_events').selectAll().execute();
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 1, next_attempt_at: plus(6) });
    const attempts = await h.db.selectFrom('webhook_attempts').selectAll().execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status_code).toBe(500);
    expect(attempts[0]?.error_message).toHaveLength(500);
  });
});
