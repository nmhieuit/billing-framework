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

describe('KyselyChargeRepository settlement queries', () => {
  const from = new Date('2026-10-09T00:00:00.000Z');
  const to = new Date('2026-10-10T00:00:00.000Z');
  const at = (iso: string) => new Date(iso);
  const idsOf = (cs: Charge[]) => cs.map((c) => c.toProps().id);

  async function seed(
    items: Array<{
      id: string;
      completedAt: Date | null;
      simulate?: string;
      amount?: number;
      currency?: 'VND' | 'USD';
    }>,
  ): Promise<void> {
    await h.uow.run(async ({ charges }) => {
      for (const item of items) {
        const charge = makeCharge(item.id, { ...item, now: item.completedAt ?? t0 });
        await charges.insert(charge);
        if (item.completedAt) await charges.save(charge.complete(item.completedAt));
      }
    });
  }

  const list = (query: { limit?: number; after?: { completedAt: Date; id: string } | null } = {}) =>
    h.uow.run(({ charges }) =>
      charges.listCompleted({ from, to, limit: query.limit ?? 100, after: query.after ?? null }),
    );

  it('listCompleted() uses [from, to) and never returns PENDING charges', async () => {
    await seed([
      { id: 'ch_before', completedAt: at('2026-10-08T23:59:59.999Z') },
      { id: 'ch_at_from', completedAt: from },
      { id: 'ch_inside', completedAt: at('2026-10-09T12:00:00.000Z') },
      { id: 'ch_last_ms', completedAt: at('2026-10-09T23:59:59.999Z') },
      { id: 'ch_at_to', completedAt: to },
      { id: 'ch_pending', completedAt: null },
    ]);
    expect(idsOf(await list())).toEqual(['ch_at_from', 'ch_inside', 'ch_last_ms']);
  });

  it('listCompleted() orders by (completed_at, id), breaking ties by id', async () => {
    const tie = at('2026-10-09T05:00:00.000Z');
    await seed([
      { id: 'ch_c', completedAt: tie },
      { id: 'ch_z', completedAt: at('2026-10-09T04:00:00.000Z') },
      { id: 'ch_a', completedAt: tie },
      { id: 'ch_b', completedAt: tie },
      { id: 'ch_y', completedAt: at('2026-10-09T06:00:00.000Z') },
    ]);
    expect(idsOf(await list())).toEqual(['ch_z', 'ch_a', 'ch_b', 'ch_c', 'ch_y']);
  });

  it('listCompleted() keyset paging starts at the tie partner and visits each charge once', async () => {
    const tie = at('2026-10-09T05:00:00.000Z');
    await seed([
      { id: 'ch_1', completedAt: at('2026-10-09T04:00:00.000Z') },
      { id: 'ch_2', completedAt: tie },
      { id: 'ch_3', completedAt: tie },
      { id: 'ch_4', completedAt: at('2026-10-09T06:00:00.000Z') },
    ]);

    const page = await list({ limit: 10, after: { completedAt: tie, id: 'ch_2' } });
    expect(idsOf(page)).toEqual(['ch_3', 'ch_4']);

    const walked: string[] = [];
    let after: { completedAt: Date; id: string } | null = null;
    for (let i = 0; i < 10; i++) {
      const next = await list({ limit: 1, after });
      const first = next[0];
      if (!first) break;
      const props = first.toProps();
      walked.push(props.id);
      after = { completedAt: props.completedAt as Date, id: props.id };
    }
    expect(walked).toEqual(['ch_1', 'ch_2', 'ch_3', 'ch_4']);
  });

  it('listCompleted() honours the limit', async () => {
    await seed([
      { id: 'ch_1', completedAt: at('2026-10-09T01:00:00.000Z') },
      { id: 'ch_2', completedAt: at('2026-10-09T02:00:00.000Z') },
      { id: 'ch_3', completedAt: at('2026-10-09T03:00:00.000Z') },
    ]);
    expect(idsOf(await list({ limit: 2 }))).toEqual(['ch_1', 'ch_2']);
  });

  it('totals() groups by (currency, status), ordered, completed only, in range, as numbers', async () => {
    await seed([
      { id: 'ch_1', completedAt: from, amount: 4_000_000_000 },
      { id: 'ch_2', completedAt: at('2026-10-09T10:00:00.000Z'), amount: 4_000_000_000 },
      {
        id: 'ch_3',
        completedAt: at('2026-10-09T11:00:00.000Z'),
        amount: 500,
        simulate: 'fail=card_declined',
      },
      { id: 'ch_4', completedAt: at('2026-10-09T12:00:00.000Z'), amount: 700, currency: 'USD' },
      { id: 'ch_5', completedAt: at('2026-10-09T13:00:00.000Z'), amount: 300, currency: 'USD' },
      {
        id: 'ch_6',
        completedAt: at('2026-10-09T14:00:00.000Z'),
        amount: 90,
        currency: 'USD',
        simulate: 'fail=card_declined',
      },
      { id: 'ch_out_before', completedAt: at('2026-10-08T23:59:59.999Z'), amount: 11 },
      { id: 'ch_out_to', completedAt: to, amount: 13 },
      { id: 'ch_pending', completedAt: null, amount: 17 },
    ]);
    const totals = await h.uow.run(({ charges }) => charges.totals({ from, to }));
    expect(totals).toEqual([
      { currency: 'USD', status: 'FAILED', count: 1, totalAmount: 90 },
      { currency: 'USD', status: 'SUCCEEDED', count: 2, totalAmount: 1000 },
      { currency: 'VND', status: 'FAILED', count: 1, totalAmount: 500 },
      { currency: 'VND', status: 'SUCCEEDED', count: 2, totalAmount: 8_000_000_000 },
    ]);
    for (const row of totals) {
      expect(typeof row.count).toBe('number');
      expect(typeof row.totalAmount).toBe('number');
    }
  });

  it('returns empty results for an empty range', async () => {
    await seed([{ id: 'ch_1', completedAt: at('2026-10-09T01:00:00.000Z') }]);
    const empty = { from: at('2027-01-01T00:00:00.000Z'), to: at('2027-01-02T00:00:00.000Z') };
    expect(
      await h.uow.run(({ charges }) => charges.listCompleted({ ...empty, limit: 10, after: null })),
    ).toEqual([]);
    expect(await h.uow.run(({ charges }) => charges.totals(empty))).toEqual([]);
  });
});
