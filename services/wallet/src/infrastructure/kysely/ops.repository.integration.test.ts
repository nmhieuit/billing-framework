import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import type { OpsActionRecord } from '../../application/ports.js';
import { createHarness, type Harness } from '../../test-support.js';

const t0 = new Date('2026-10-10T10:00:00.123Z');

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const record = (n: number, overrides: Partial<OpsActionRecord> = {}): OpsActionRecord => ({
  id: `act_${n}`,
  action: 'FREEZE',
  actor: 'ops1',
  reason: 'fraud suspected',
  target: 'wallet:c1',
  idempotencyKey: `key-${n}`,
  fingerprint: `fp-${n}`,
  result: '{"ok":true}',
  createdAt: t0,
  ...overrides,
});

describe('KyselyOpsRepository', () => {
  it('inserts a record and finds it by idempotency key with every field', async () => {
    const r = record(1);
    await h.uow.run(h.acme, ({ ops }) => ops.insert(r));
    const found = await h.uow.run(h.acme, ({ ops }) => ops.find('key-1'));
    expect(found).toMatchObject(r);
    expect(await h.uow.run(h.acme, ({ ops }) => ops.find('nope'))).toBeNull();
    expect(await h.uow.run(h.beta, ({ ops }) => ops.find('key-1'))).toBeNull();
  });

  it('answers DuplicateKeyError tagged ops_action for a repeated key or id', async () => {
    await h.uow.run(h.acme, ({ ops }) => ops.insert(record(2)));
    const isOps = (error: unknown) =>
      error instanceof DuplicateKeyError && error.source === 'ops_action';
    await expect(
      h.uow.run(h.acme, ({ ops }) => ops.insert(record(3, { idempotencyKey: 'key-2' }))),
    ).rejects.toSatisfy(isOps);
    await expect(
      h.uow.run(h.acme, ({ ops }) => ops.insert(record(2, { idempotencyKey: 'key-other' }))),
    ).rejects.toSatisfy(isOps);
  });

  it('lists newest first by seq with a beforeSeq cursor and a limit', async () => {
    for (const n of [10, 11, 12]) {
      await h.uow.run(h.beta, ({ ops }) => ops.insert(record(n)));
    }
    const all = await h.uow.run(h.beta, ({ ops }) => ops.list({ limit: 10, beforeSeq: null }));
    expect(all.map((r) => r.id)).toEqual(['act_12', 'act_11', 'act_10']);
    const seqs = all.map((r) => r.seq);
    expect(seqs.every((s) => typeof s === 'number')).toBe(true);
    const limited = await h.uow.run(h.beta, ({ ops }) => ops.list({ limit: 2, beforeSeq: null }));
    expect(limited.map((r) => r.id)).toEqual(['act_12', 'act_11']);
    const cursor = limited[1]?.seq ?? 0;
    const rest = await h.uow.run(h.beta, ({ ops }) => ops.list({ limit: 10, beforeSeq: cursor }));
    expect(rest.map((r) => r.id)).toEqual(['act_10']);
  });

  it('blocks direct update and delete with the append-only trigger', async () => {
    const t = sql.id('t_acme', 'ops_actions');
    await expect(sql`update ${t} set reason = 'x'`.execute(h.db)).rejects.toThrow();
    await expect(sql`delete from ${t}`.execute(h.db)).rejects.toThrow();
  });
});
