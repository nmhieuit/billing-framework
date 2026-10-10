import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidChargeError } from '../domain/errors.js';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CreateCharge, type CreateChargeInput } from './create-charge.js';
import { IdempotencyConflictError } from './errors.js';
import { GetCharge } from './get-charge.js';

let h: Harness;
let createCharge: CreateCharge;
let getCharge: GetCharge;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  getCharge = new GetCharge({ uow: h.uow });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
});

const input = (overrides: Partial<CreateChargeInput> = {}): CreateChargeInput => ({
  idempotencyKey: 'key-1',
  amount: 1000,
  currency: 'VND',
  reference: 'tp_1',
  ...overrides,
});

describe('CreateCharge metadata', () => {
  it('stores metadata, echoes it in both views and persists it', async () => {
    const { body } = await createCharge.execute(input({ metadata: { tenantId: 'acme', k: 'v' } }));
    expect(body.metadata).toEqual({ k: 'v', tenantId: 'acme' });
    const viewed = await getCharge.execute(body.chargeId);
    expect(viewed.metadata).toEqual({ k: 'v', tenantId: 'acme' });
    const [row] = await h.db.selectFrom('charges').select('metadata').execute();
    expect(JSON.parse(row?.metadata ?? 'null')).toEqual({ k: 'v', tenantId: 'acme' });
  });

  it('omits metadata from the views when none was sent', async () => {
    const { body } = await createCharge.execute(input());
    expect(body).not.toHaveProperty('metadata');
    expect(await getCharge.execute(body.chargeId)).not.toHaveProperty('metadata');
  });

  it('replays for the same key and same metadata regardless of key order', async () => {
    const first = await createCharge.execute(input({ metadata: { b: '2', a: '1' } }));
    const replay = await createCharge.execute(input({ metadata: { a: '1', b: '2' } }));
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.body.chargeId).toBe(first.body.chargeId);
  });

  it('answers a conflict when the same key carries different metadata', async () => {
    await createCharge.execute(input({ metadata: { tenantId: 'acme' } }));
    await expect(
      createCharge.execute(input({ metadata: { tenantId: 'beta' } })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(createCharge.execute(input())).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rejects invalid metadata and persists nothing', async () => {
    await expect(
      createCharge.execute(input({ metadata: { 'bad-key': 'v' } })),
    ).rejects.toBeInstanceOf(InvalidChargeError);
    expect(await h.db.selectFrom('charges').selectAll().execute()).toHaveLength(0);
  });
});
