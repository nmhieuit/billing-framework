import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { InvalidSettlementQueryError } from './errors.js';
import { GetSettlement } from './get-settlement.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let getSettlement: GetSettlement;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
  getSettlement = new GetSettlement({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});

async function complete(
  at: string,
  key: string,
  options: { simulate?: string; amount?: number; currency?: string } = {},
): Promise<string> {
  h.clock.set(at);
  const { body } = await createCharge.execute({
    idempotencyKey: key,
    amount: options.amount ?? 1000,
    currency: options.currency ?? 'VND',
    reference: `ref-${key}`,
    simulate: options.simulate,
  });
  await completeDue.execute();
  return body.chargeId;
}

let c1: string;
let c2: string;
let c3: string;
let c4: string;

beforeEach(async () => {
  await resetTables(h.db);
  c1 = await complete('2026-10-09T23:59:59.900Z', 'a', { amount: 1000 });
  c2 = await complete('2026-10-10T00:00:00.000Z', 'b', {
    amount: 2500,
    simulate: 'fail=card_declined',
  });
  c3 = await complete('2026-10-10T00:00:00.000Z', 'c', { amount: 4000 });
  c4 = await complete('2026-10-10T08:00:00.000Z', 'd', { amount: 500, currency: 'USD' });
  // Một charge còn PENDING: không được xuất hiện trong sao kê.
  h.clock.set('2026-10-10T09:00:00.000Z');
  await createCharge.execute({
    idempotencyKey: 'e',
    amount: 9999,
    currency: 'VND',
    reference: 'ref-e',
    simulate: 'delay=100',
  });
  h.clock.set('2026-10-11T12:00:00.000Z');
});

const ids = (view: { items: Array<{ chargeId: string }> }) => view.items.map((i) => i.chargeId);

describe('GetSettlement', () => {
  it('lists the charges completed on that UTC day, with totals', async () => {
    const day1 = await getSettlement.execute({ date: '2026-10-09' });
    expect(ids(day1)).toEqual([c1]);
    expect(day1.nextCursor).toBeNull();
    expect(day1.totals).toEqual([
      { currency: 'VND', status: 'SUCCEEDED', count: 1, totalAmount: 1000 },
    ]);

    const day2 = await getSettlement.execute({ date: '2026-10-10' });
    expect(ids(day2)).toEqual([c2, c3, c4]);
    expect(day2.items[0]).toEqual({
      chargeId: c2,
      reference: 'ref-b',
      amount: 2500,
      currency: 'VND',
      status: 'FAILED',
      failureCode: 'card_declined',
      completedAt: '2026-10-10T00:00:00.000Z',
    });
    expect(day2.items[1]).not.toHaveProperty('failureCode');
    expect(day2.totals).toEqual([
      { currency: 'USD', status: 'SUCCEEDED', count: 1, totalAmount: 500 },
      { currency: 'VND', status: 'FAILED', count: 1, totalAmount: 2500 },
      { currency: 'VND', status: 'SUCCEEDED', count: 1, totalAmount: 4000 },
    ]);
  });

  it('puts a charge completed at 00:00:00.000 in the new day, not the previous one', async () => {
    expect(ids(await getSettlement.execute({ date: '2026-10-09' }))).not.toContain(c2);
  });

  it('returns an empty list and no totals for a day without charges', async () => {
    expect(await getSettlement.execute({ date: '2026-10-08' })).toEqual({
      date: '2026-10-08',
      items: [],
      nextCursor: null,
      totals: [],
    });
  });

  it('pages with a cursor, tie-breaking equal timestamps by id, and keeps whole-day totals', async () => {
    const first = await getSettlement.execute({ date: '2026-10-10', limit: 2 });
    expect(ids(first)).toEqual([c2, c3]);
    expect(first.nextCursor).not.toBeNull();

    const second = await getSettlement.execute({
      date: '2026-10-10',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(ids(second)).toEqual([c4]);
    expect(second.nextCursor).toBeNull();
    expect(second.totals).toEqual(first.totals);
  });

  it('walks the whole day one item at a time without skipping or repeating', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const view = await getSettlement.execute({ date: '2026-10-10', limit: 1, cursor });
      seen.push(...ids(view));
      if (view.nextCursor === null) break;
      cursor = view.nextCursor;
    }
    expect(seen).toEqual([c2, c3, c4]);
  });

  it('has no next page when the limit exactly matches the number of items', async () => {
    const view = await getSettlement.execute({ date: '2026-10-10', limit: 3 });
    expect(ids(view)).toHaveLength(3);
    expect(view.nextCursor).toBeNull();
  });

  it('accepts today and rejects tomorrow (UTC)', async () => {
    h.clock.set('2026-10-10T12:00:00.000Z');
    await expect(getSettlement.execute({ date: '2026-10-10' })).resolves.toBeDefined();
    await expect(getSettlement.execute({ date: '2026-10-11' })).rejects.toBeInstanceOf(
      InvalidSettlementQueryError,
    );
  });

  it.each(['2026-13-01', '2026-02-30', 'abcd', '', '2026-1-1', '2026-10-09T00:00:00Z'])(
    'rejects the invalid date %j',
    async (date) => {
      await expect(getSettlement.execute({ date })).rejects.toBeInstanceOf(
        InvalidSettlementQueryError,
      );
    },
  );

  it.each([0, 1001, 1.5, Number.NaN, -1])('rejects the invalid limit %d', async (limit) => {
    await expect(getSettlement.execute({ date: '2026-10-10', limit })).rejects.toBeInstanceOf(
      InvalidSettlementQueryError,
    );
  });

  it.each([
    'not-base64!',
    Buffer.from('{}').toString('base64url'),
    Buffer.from('not json').toString('base64url'),
    Buffer.from(JSON.stringify({ c: 'yesterday', i: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ c: '2026-10-10T00:00:00.000Z', i: '' })).toString('base64url'),
  ])('rejects the invalid cursor %j', async (cursor) => {
    await expect(getSettlement.execute({ date: '2026-10-10', cursor })).rejects.toBeInstanceOf(
      InvalidSettlementQueryError,
    );
  });
});
