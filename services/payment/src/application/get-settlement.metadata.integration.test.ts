import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { GetSettlement } from './get-settlement.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let getSettlement: GetSettlement;

beforeAll(async () => {
  h = await createHarness('2026-10-10T10:00:00.000Z');
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
  getSettlement = new GetSettlement({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set('2026-10-10T10:00:00.000Z');
});

describe('GetSettlement metadata', () => {
  it('returns metadata on items that have it and omits it on the others', async () => {
    await createCharge.execute({
      idempotencyKey: 'a',
      amount: 1000,
      currency: 'VND',
      reference: 'with-meta',
      metadata: { tenantId: 'acme' },
    });
    await createCharge.execute({
      idempotencyKey: 'b',
      amount: 2000,
      currency: 'VND',
      reference: 'no-meta',
    });
    await completeDue.execute();
    h.clock.set('2026-10-11T12:00:00.000Z');

    const view = await getSettlement.execute({ date: '2026-10-10' });
    const byRef = new Map(view.items.map((item) => [item.reference, item]));
    expect(byRef.get('with-meta')?.metadata).toEqual({ tenantId: 'acme' });
    expect(byRef.get('no-meta')).not.toHaveProperty('metadata');
  });
});
