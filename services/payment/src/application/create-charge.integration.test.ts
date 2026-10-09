import { InvalidMoneyError } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidChargeError } from '../domain/errors.js';
import { InvalidScenarioError } from '../domain/scenario.js';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { IdempotencyConflictError } from './errors.js';
import { CreateCharge, type CreateChargeInput } from './create-charge.js';

let h: Harness;
let createCharge: CreateCharge;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
});

const input = (overrides: Partial<CreateChargeInput> = {}): CreateChargeInput => ({
  idempotencyKey: 'key-1',
  amount: 150000,
  currency: 'VND',
  reference: 'topup-1',
  ...overrides,
});

const chargeRows = () => h.db.selectFrom('charges').selectAll().execute();

describe('CreateCharge', () => {
  it('creates a PENDING charge due immediately and answers 202', async () => {
    const result = await createCharge.execute(input());
    expect(result).toMatchObject({
      status: 202,
      replayed: false,
      responseTimeout: false,
      body: {
        reference: 'topup-1',
        amount: 150000,
        currency: 'VND',
        status: 'PENDING',
        createdAt: '2026-10-09T10:00:00.000Z',
      },
    });
    const rows = await chargeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.body.chargeId,
      status: 'PENDING',
      due_at: h.clock.now(),
    });
  });

  it('schedules the charge after the delay in X-Simulate', async () => {
    await createCharge.execute(input({ simulate: 'delay=5' }));
    const [row] = await chargeRows();
    expect(row?.due_at).toEqual(new Date('2026-10-09T10:00:05.000Z'));
  });

  it('flags responseTimeout on the first call only', async () => {
    const first = await createCharge.execute(input({ simulate: 'response=timeout' }));
    const replay = await createCharge.execute(input({ simulate: 'response=timeout' }));
    expect(first).toMatchObject({ replayed: false, responseTimeout: true });
    expect(replay).toMatchObject({ replayed: true, responseTimeout: false });
    expect(replay.body).toEqual(first.body);
  });

  it('replays the stored 202 for the same key and the same content', async () => {
    const first = await createCharge.execute(input());
    h.clock.advanceSeconds(30);
    const replay = await createCharge.execute(input());
    expect(replay).toMatchObject({ status: 202, replayed: true });
    expect(replay.body).toEqual(first.body);
    expect(await chargeRows()).toHaveLength(1);
  });

  it('treats reordered X-Simulate tokens as the same content', async () => {
    const first = await createCharge.execute(input({ simulate: 'fail=a_b,delay=2' }));
    const replay = await createCharge.execute(input({ simulate: 'delay=2, fail=a_b' }));
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.body.chargeId).toBe(first.body.chargeId);
  });

  it.each([
    ['amount', { amount: 150001 }],
    ['currency', { currency: 'USD' }],
    ['reference', { reference: 'topup-2' }],
    ['X-Simulate', { simulate: 'fail=card_declined' }],
  ])('rejects the same key with a different %s', async (_name, change) => {
    await createCharge.execute(input());
    await expect(createCharge.execute(input(change))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await chargeRows()).toHaveLength(1);
  });

  it('creates exactly one charge when the same key is submitted concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createCharge.execute(input())),
    );
    expect(new Set(results.map((r) => r.body.chargeId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await chargeRows()).toHaveLength(1);
  });

  it('keeps different keys independent', async () => {
    await createCharge.execute(input({ idempotencyKey: 'a' }));
    await createCharge.execute(input({ idempotencyKey: 'b' }));
    expect(await chargeRows()).toHaveLength(2);
  });

  it.each([
    ['a fractional amount', { amount: 10.5 }, InvalidMoneyError],
    ['an unsupported currency', { currency: 'EUR' }, InvalidMoneyError],
    ['a zero amount', { amount: 0 }, InvalidChargeError],
    ['a negative amount', { amount: -5 }, InvalidChargeError],
    ['an empty reference', { reference: '  ' }, InvalidChargeError],
    ['an unknown X-Simulate token', { simulate: 'explode=1' }, InvalidScenarioError],
  ])('rejects %s and persists nothing', async (_name, change, errorType) => {
    await expect(createCharge.execute(input(change))).rejects.toBeInstanceOf(errorType);
    expect(await chargeRows()).toHaveLength(0);
    expect(await h.db.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(0);
  });
});
