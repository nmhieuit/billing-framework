import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Account } from '../domain/account.js';
import { CustomerId } from '../domain/customer-id.js';
import { InvalidOpsRequestError } from '../domain/ops.js';
import type { TenantId } from '../domain/tenant-id.js';
import { RecordingMetrics } from '../test-support-metrics.js';
import {
  createHarness,
  expectLedgerInvariants,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { OpsIdempotencyConflictError } from './errors.js';
import { OpsActionRecorder } from './ops-recorder.js';
import type { Repositories } from './ports.js';

let h: Harness;
let metrics: RecordingMetrics;
let recorder: OpsActionRecorder;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  metrics = new RecordingMetrics();
  recorder = new OpsActionRecorder({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    metrics,
  });
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const opsRows = (tenant: TenantId, key: string) =>
  h.db
    .withSchema(schema(tenant))
    .selectFrom('ops_actions')
    .selectAll()
    .where('idempotency_key', '=', key)
    .execute();
const accountRows = (tenant: TenantId, id: string) =>
  h.db
    .withSchema(schema(tenant))
    .selectFrom('accounts')
    .select('id')
    .where('id', '=', id)
    .execute();

const request = (key: string) => ({ actor: 'op@x', reason: 'because', idempotencyKey: key });
const newKey = () => `rec-key-${++counter}`;

/** Thao tác thử: mở một ví mới (hiệu ứng ghi vào sổ) rồi trả kết quả. */
function openWalletWork(customer: string, effects: { runs: number }) {
  return async (ctx: { repositories: Repositories; now: Date }) => {
    effects.runs++;
    await ctx.repositories.accounts.insert(
      Account.openWallet({ customerId: CustomerId.parse(customer), currency: 'VND', now: ctx.now }),
    );
    return { result: { customer }, record: true };
  };
}

describe('OpsActionRecorder', () => {
  it('records exactly one audit row with fingerprint and JSON result', async () => {
    const key = newKey();
    const effects = { runs: 0 };
    const run = await recorder.run({
      tenant: h.acme,
      action: 'ADJUST',
      request: request(key),
      target: 'wallet:rc1',
      params: { a: 1 },
      work: openWalletWork('rc1', effects),
    });
    expect(run.replayed).toBe(false);
    const rows = await opsRows(h.acme, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'ADJUST',
      actor: 'op@x',
      reason: 'because',
      target: 'wallet:rc1',
    });
    expect(rows[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(rows[0]?.result ?? '')).toEqual(run.result);
    expect(metrics.calls).toContainEqual(['opsAction', 'acme', 'ADJUST', 'ok']);
  });

  it('replays the stored result for the same key and params without running work again', async () => {
    const key = newKey();
    const effects = { runs: 0 };
    const input = {
      tenant: h.acme,
      action: 'ADJUST' as const,
      request: request(key),
      target: 'wallet:rc2',
      params: { a: 1 },
      work: openWalletWork('rc2', effects),
    };
    const first = await recorder.run(input);
    const second = await recorder.run(input);
    expect(second).toEqual({ result: first.result, replayed: true });
    expect(effects.runs).toBe(1);
    expect(await opsRows(h.acme, key)).toHaveLength(1);
  });

  it('rejects the same key with different params', async () => {
    const key = newKey();
    const effects = { runs: 0 };
    const base = {
      tenant: h.acme,
      action: 'ADJUST' as const,
      request: request(key),
      target: 'wallet:rc3',
      work: openWalletWork('rc3', effects),
    };
    await recorder.run({ ...base, params: { a: 1 } });
    await expect(recorder.run({ ...base, params: { a: 2 } })).rejects.toBeInstanceOf(
      OpsIdempotencyConflictError,
    );
    expect(metrics.calls).toContainEqual(['opsAction', 'acme', 'ADJUST', 'rejected']);
  });

  it('writes no audit row when work says record:false', async () => {
    const key = newKey();
    const run = await recorder.run({
      tenant: h.acme,
      action: 'FREEZE',
      request: request(key),
      target: 'wallet:rc4',
      params: {},
      work: async () => ({ result: { changed: false }, record: false }),
    });
    expect(run.result).toEqual({ changed: false });
    expect(await opsRows(h.acme, key)).toHaveLength(0);
    expect(metrics.calls).toContainEqual(['opsAction', 'acme', 'FREEZE', 'noop']);
  });

  it('rolls everything back and counts rejected when work throws', async () => {
    const key = newKey();
    await expect(
      recorder.run({
        tenant: h.acme,
        action: 'ADJUST',
        request: request(key),
        target: 'wallet:rc5',
        params: {},
        work: async (ctx) => {
          await ctx.repositories.accounts.insert(
            Account.openWallet({
              customerId: CustomerId.parse('rc5'),
              currency: 'VND',
              now: ctx.now,
            }),
          );
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(await opsRows(h.acme, key)).toHaveLength(0);
    expect(await accountRows(h.acme, 'wallet:rc5')).toHaveLength(0);
    expect(metrics.calls).toContainEqual(['opsAction', 'acme', 'ADJUST', 'rejected']);
  });

  it('gives five concurrent same-key calls one effect and one shared result', async () => {
    const key = newKey();
    const effects = { runs: 0 };
    const input = {
      tenant: h.acme,
      action: 'ADJUST' as const,
      request: request(key),
      target: 'wallet:rc6',
      params: { a: 1 },
      work: openWalletWork('rc6', effects),
    };
    const runs = await Promise.all(Array.from({ length: 5 }, () => recorder.run(input)));
    expect(new Set(runs.map((r) => JSON.stringify(r.result))).size).toBe(1);
    expect(runs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await opsRows(h.acme, key)).toHaveLength(1);
    expect(await accountRows(h.acme, 'wallet:rc6')).toHaveLength(1);
  });

  it('keeps the same key independent across tenants', async () => {
    const key = newKey();
    const effects = { runs: 0 };
    for (const tenant of [h.acme, h.beta]) {
      const run = await recorder.run({
        tenant,
        action: 'ADJUST',
        request: request(key),
        target: 'wallet:rc7',
        params: {},
        work: openWalletWork('rc7', effects),
      });
      expect(run.replayed).toBe(false);
    }
    expect(effects.runs).toBe(2);
  });

  it('rejects invalid requests (empty reason, empty actor, over-long key)', async () => {
    const work = async () => ({ result: {}, record: true });
    const base = { tenant: h.acme, action: 'ADJUST' as const, target: 't', params: {}, work };
    for (const bad of [
      { actor: 'op', reason: '', idempotencyKey: newKey() },
      { actor: '', reason: 'r', idempotencyKey: newKey() },
      { actor: 'op', reason: 'r', idempotencyKey: 'k'.repeat(201) },
    ]) {
      await expect(recorder.run({ ...base, request: bad })).rejects.toBeInstanceOf(
        InvalidOpsRequestError,
      );
    }
    expect(metrics.calls.filter((c) => c[3] === 'rejected')).toHaveLength(3);
  });
});
