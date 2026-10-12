import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import { RecordingMetrics } from '../test-support-metrics.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { InvalidQueryError } from './errors.js';
import { FreezeWallet } from './freeze-wallet.js';
import { ListOpsActions } from './list-ops-actions.js';
import { OpsActionRecorder } from './ops-recorder.js';

let h: Harness;
let list: ListOpsActions;
let freeze: FreezeWallet;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  const recorder = new OpsActionRecorder({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    metrics: new RecordingMetrics(),
  });
  list = new ListOpsActions({ uow: h.uow });
  freeze = new FreezeWallet({ recorder });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

/** Tạo `count` thao tác đóng/mở băng xen kẽ trên một ví của tenant, trả về id theo thứ tự tạo. */
const makeActions = async (tenant: TenantId, customer: string, count: number) => {
  await fundWallet(h, { tenant, customer, amount: 1000 });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    h.clock.advanceSeconds(1);
    const out = await freeze.execute({
      tenant,
      customerId: customer,
      frozen: i % 2 === 0,
      actor: `op${i}`,
      reason: 'test',
      idempotencyKey: `lo-key-${++counter}`,
    });
    if (!out.actionId) throw new Error('expected a recorded action');
    ids.push(out.actionId);
  }
  return ids;
};

describe('ListOpsActions', () => {
  it('lists newest first and paginates without duplicates or gaps', async () => {
    const created = await makeActions(h.beta, 'lo1', 5);
    const all = await list.execute({ tenant: h.beta });
    expect(all.items.map((i) => i.id)).toEqual([...created].reverse());
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list.execute({ tenant: h.beta, limit: 2, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(seen).toEqual([...created].reverse());
    expect(pages).toBe(3);
  });

  it('exposes only the public fields', async () => {
    await makeActions(h.beta, 'lo2', 1);
    const { items } = await list.execute({ tenant: h.beta, limit: 1 });
    const [item] = items;
    expect(Object.keys(item ?? {}).sort()).toEqual(
      ['action', 'actor', 'createdAt', 'id', 'reason', 'target'].sort(),
    );
    expect(JSON.stringify(item)).not.toMatch(/fingerprint|idempotency|result/i);
  });

  it('rejects invalid limit and cursor', async () => {
    for (const limit of [0, 201, 1.5]) {
      await expect(list.execute({ tenant: h.acme, limit })).rejects.toBeInstanceOf(
        InvalidQueryError,
      );
    }
    for (const cursor of ['abc', '0', '-1']) {
      await expect(list.execute({ tenant: h.acme, cursor })).rejects.toBeInstanceOf(
        InvalidQueryError,
      );
    }
  });

  it('does not show another tenant their actions', async () => {
    const acmeIds = await makeActions(h.acme, 'lo3', 2);
    const beta = await list.execute({ tenant: h.beta, limit: 200 });
    for (const id of acmeIds) expect(beta.items.map((i) => i.id)).not.toContain(id);
    const acme = await list.execute({ tenant: h.acme, limit: 200 });
    for (const id of acmeIds) expect(acme.items.map((i) => i.id)).toContain(id);
  });
});
