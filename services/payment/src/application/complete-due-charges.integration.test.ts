import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set('2026-10-09T10:00:00.000Z');
});

const create = (key: string, simulate?: string) =>
  createCharge.execute({
    idempotencyKey: key,
    amount: 1000,
    currency: 'VND',
    reference: `ref-${key}`,
    simulate,
  });
const charges = () =>
  h.db
    .selectFrom('charges')
    .select(['id', 'status', 'failure_code', 'completed_at'])
    .orderBy('id')
    .execute();
const events = () => h.db.selectFrom('webhook_events').selectAll().orderBy('event_id').execute();

describe('CompleteDueCharges', () => {
  it('completes only the charges that are due, and queues one webhook event for each', async () => {
    const ok = await create('a');
    const delayed = await create('b', 'delay=10');
    const failing = await create('c', 'fail=card_declined');

    expect(await completeDue.execute()).toBe(2);

    const byId = new Map((await charges()).map((c) => [c.id, c]));
    expect(byId.get(ok.body.chargeId)).toMatchObject({ status: 'SUCCEEDED', failure_code: null });
    expect(byId.get(failing.body.chargeId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'card_declined',
    });
    expect(byId.get(delayed.body.chargeId)).toMatchObject({
      status: 'PENDING',
      completed_at: null,
    });

    const queued = await events();
    expect(queued.map((e) => [e.charge_id, e.event_type, e.status, e.attempts])).toEqual([
      [ok.body.chargeId, 'charge.succeeded', 'PENDING', 0],
      [failing.body.chargeId, 'charge.failed', 'PENDING', 0],
    ]);
    expect(queued[0]?.next_attempt_at).toEqual(h.clock.now());

    h.clock.advanceSeconds(10);
    expect(await completeDue.execute()).toBe(1);
    expect((await charges()).every((c) => c.status !== 'PENDING')).toBe(true);
    expect(await events()).toHaveLength(3);
  });

  it('stamps completed_at with the clock, keeping milliseconds', async () => {
    h.clock.set('2026-10-09T10:00:00.123Z');
    await create('a');
    await completeDue.execute();
    const [row] = await charges();
    expect(row?.completed_at).toEqual(new Date('2026-10-09T10:00:00.123Z'));
  });

  it('is idempotent: running again completes nothing and queues nothing', async () => {
    await create('a');
    expect(await completeDue.execute()).toBe(1);
    expect(await completeDue.execute()).toBe(0);
    expect(await events()).toHaveLength(1);
  });

  it('queues no event for webhook=drop, and flags send_twice for webhook=duplicate', async () => {
    const dropped = await create('a', 'webhook=drop');
    const doubled = await create('b', 'webhook=duplicate');
    expect(await completeDue.execute()).toBe(2);

    const queued = await events();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ charge_id: doubled.body.chargeId, send_twice: true });
    const droppedRow = (await charges()).find((c) => c.id === dropped.body.chargeId);
    expect(droppedRow?.status).toBe('SUCCEEDED');
  });

  it('honours the limit', async () => {
    for (const key of ['a', 'b', 'c']) await create(key);
    expect(await completeDue.execute(2)).toBe(2);
    expect(await completeDue.execute(2)).toBe(1);
  });

  it('lets two concurrent workers split the work without completing anything twice', async () => {
    for (const key of ['a', 'b', 'c', 'd']) await create(key);
    const [first, second] = await Promise.all([completeDue.execute(2), completeDue.execute(2)]);
    expect(first + second).toBe(4);
    expect((await charges()).every((c) => c.status === 'SUCCEEDED')).toBe(true);
    const queued = await events();
    expect(new Set(queued.map((e) => e.charge_id)).size).toBe(4);
    expect(queued).toHaveLength(4);
  });
});
