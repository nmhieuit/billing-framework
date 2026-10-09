import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { ChargeNotFoundError } from './errors.js';
import { GetCharge } from './get-charge.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let getCharge: GetCharge;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
  getCharge = new GetCharge({ uow: h.uow });
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

describe('GetCharge', () => {
  it('shows a pending charge without completion fields', async () => {
    const { body } = await create('a', 'delay=10');
    expect(await getCharge.execute(body.chargeId)).toStrictEqual({
      chargeId: body.chargeId,
      reference: 'ref-a',
      amount: 1000,
      currency: 'VND',
      status: 'PENDING',
      createdAt: '2026-10-09T10:00:00.000Z',
    });
  });

  it('shows the outcome of a completed and of a failed charge', async () => {
    const ok = await create('a');
    const failed = await create('b', 'fail=card_declined');
    h.clock.advanceSeconds(1);
    await completeDue.execute();

    expect(await getCharge.execute(ok.body.chargeId)).toMatchObject({
      status: 'SUCCEEDED',
      completedAt: '2026-10-09T10:00:01.000Z',
    });
    expect(await getCharge.execute(ok.body.chargeId)).not.toHaveProperty('failureCode');
    expect(await getCharge.execute(failed.body.chargeId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
    });
  });

  it('throws ChargeNotFoundError for an unknown id', async () => {
    await expect(getCharge.execute('ch_nope')).rejects.toBeInstanceOf(ChargeNotFoundError);
  });
});
