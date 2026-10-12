import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidCustomerError } from '../domain/errors.js';
import type { TenantId } from '../domain/tenant-id.js';
import { RecordingMetrics } from '../test-support-metrics.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { WalletNotFoundError } from './errors.js';
import { FreezeWallet } from './freeze-wallet.js';
import { OpsActionRecorder } from './ops-recorder.js';

let h: Harness;
let metrics: RecordingMetrics;
let freeze: FreezeWallet;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  metrics = new RecordingMetrics();
  freeze = new FreezeWallet({
    recorder: new OpsActionRecorder({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
      metrics,
    }),
  });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const newCustomer = () => `fz${++counter}`;
const newKey = () => `fz-key-${++counter}`;
const input = (customerId: string, frozen: boolean, key = newKey()) => ({
  tenant: h.acme,
  customerId,
  frozen,
  actor: 'op@x',
  reason: 'fraud review',
  idempotencyKey: key,
});
const walletRow = (customer: string) =>
  h.db
    .withSchema(schema(h.acme))
    .selectFrom('accounts')
    .select(['frozen_at', 'frozen_by', 'frozen_reason'])
    .where('id', '=', `wallet:${customer}`)
    .executeTakeFirstOrThrow();
const opsActions = (customer: string) =>
  h.db
    .withSchema(schema(h.acme))
    .selectFrom('ops_actions')
    .selectAll()
    .where('target', '=', `wallet:${customer}`)
    .orderBy('seq')
    .execute();

describe('FreezeWallet', () => {
  it('freezes an open wallet and records actor, reason and audit row', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    const result = await freeze.execute(input(customer, true));
    expect(result).toMatchObject({
      customerId: customer,
      frozen: true,
      changed: true,
      frozenAt: '2026-10-10T10:00:00.000Z',
    });
    expect(result.actionId).not.toBeNull();
    const row = await walletRow(customer);
    expect(row.frozen_by).toBe('op@x');
    expect(row.frozen_reason).toBe('fraud review');
    expect(row.frozen_at).not.toBeNull();
    expect((await opsActions(customer)).map((a) => a.action)).toEqual(['FREEZE']);
  });

  it('is a no-op when already frozen (different key): no new audit row, metric noop', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    await freeze.execute(input(customer, true));
    const again = await freeze.execute(input(customer, true));
    expect(again).toMatchObject({
      frozen: true,
      changed: false,
      frozenAt: '2026-10-10T10:00:00.000Z',
      actionId: null,
    });
    expect(await opsActions(customer)).toHaveLength(1);
    expect(metrics.calls).toContainEqual(['opsAction', 'acme', 'FREEZE', 'noop']);
  });

  it('unfreezes and clears the frozen columns', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    await freeze.execute(input(customer, true));
    const result = await freeze.execute(input(customer, false));
    expect(result).toMatchObject({ frozen: false, changed: true, frozenAt: null });
    expect(await walletRow(customer)).toEqual({
      frozen_at: null,
      frozen_by: null,
      frozen_reason: null,
    });
    expect((await opsActions(customer)).map((a) => a.action)).toEqual(['FREEZE', 'UNFREEZE']);
  });

  it.each([true, false])(
    'five concurrent requests with different keys change the state once (frozen=%s)',
    async (frozen) => {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 1000 });
      if (!frozen) await freeze.execute(input(customer, true));
      const before = (await opsActions(customer)).length;
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          freeze.execute({ ...input(customer, frozen), actor: `op${i}` }),
        ),
      );
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      const audit = (await opsActions(customer)).slice(before);
      expect(audit.map((a) => a.action)).toEqual([frozen ? 'FREEZE' : 'UNFREEZE']);
      if (frozen) {
        const winner = results.find((r) => r.changed);
        expect(winner?.actionId).toBe(audit[0]?.id);
        expect((await walletRow(customer)).frozen_by).toBe(audit[0]?.actor);
      } else {
        expect((await walletRow(customer)).frozen_at).toBeNull();
      }
    },
  );

  it('rejects an unknown wallet', async () => {
    await expect(freeze.execute(input('nobody-fz', true))).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  it('rejects a malformed customer id', async () => {
    await expect(freeze.execute(input('bad id!', true))).rejects.toBeInstanceOf(
      InvalidCustomerError,
    );
  });
});
