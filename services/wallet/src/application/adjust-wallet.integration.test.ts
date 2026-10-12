import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientFundsError } from '../domain/errors.js';
import { InvalidOpsRequestError } from '../domain/ops.js';
import type { TenantId } from '../domain/tenant-id.js';
import { RecordingMetrics } from '../test-support-metrics.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { AdjustWallet } from './adjust-wallet.js';
import { WalletNotFoundError } from './errors.js';
import { FreezeWallet } from './freeze-wallet.js';
import { OpsActionRecorder } from './ops-recorder.js';

let h: Harness;
let adjust: AdjustWallet;
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
  adjust = new AdjustWallet({ recorder, ids: h.ids });
  freeze = new FreezeWallet({ recorder });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const newCustomer = () => `aj${++counter}`;
const input = (customerId: string, overrides: Record<string, unknown> = {}) => ({
  tenant: h.acme,
  customerId,
  direction: 'CREDIT',
  amount: 30000,
  currency: 'VND',
  actor: 'op@x',
  reason: 'goodwill',
  idempotencyKey: `aj-key-${++counter}`,
  ...overrides,
});
const balance = async (accountId: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(schema(h.acme))
        .selectFrom('accounts')
        .select('balance')
        .where('id', '=', accountId)
        .executeTakeFirstOrThrow()
    ).balance,
  );
const opsCount = async (key: string) =>
  (
    await h.db
      .withSchema(schema(h.acme))
      .selectFrom('ops_actions')
      .select('id')
      .where('idempotency_key', '=', key)
      .execute()
  ).length;

describe('AdjustWallet', () => {
  it('credits the wallet against the adjustment account and keys the ledger by action id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const before = await balance('system:ADJUSTMENT:VND');
    const out = await adjust.execute(input(customer));
    expect(await balance(`wallet:${customer}`)).toBe(130000);
    expect(await balance('system:ADJUSTMENT:VND')).toBe(before - 30000);
    const tx = await h.db
      .withSchema(schema(h.acme))
      .selectFrom('ledger_transactions')
      .selectAll()
      .where('id', '=', out.transactionId)
      .executeTakeFirstOrThrow();
    expect(tx.kind).toBe('ADJUSTMENT');
    expect(tx.business_key).toBe(`adjustment:${out.actionId}`);
  });

  it('debits the wallet', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    await adjust.execute(input(customer, { direction: 'DEBIT', amount: 40000 }));
    expect(await balance(`wallet:${customer}`)).toBe(60000);
  });

  it('refuses a debit beyond the balance and leaves no audit row', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    const request = input(customer, { direction: 'DEBIT', amount: 5000 });
    await expect(adjust.execute(request)).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await opsCount(request.idempotencyKey)).toBe(0);
    expect(await balance(`wallet:${customer}`)).toBe(1000);
  });

  it('works on a frozen wallet', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    await freeze.execute({
      tenant: h.acme,
      customerId: customer,
      frozen: true,
      actor: 'op',
      reason: 'r',
      idempotencyKey: `aj-key-${++counter}`,
    });
    await adjust.execute(input(customer, { amount: 500 }));
    expect(await balance(`wallet:${customer}`)).toBe(1500);
  });

  it('rejects a currency different from the wallet', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    await expect(adjust.execute(input(customer, { currency: 'USD' }))).rejects.toBeInstanceOf(
      InvalidOpsRequestError,
    );
  });

  it.each([0, -5, 1.5, Number.NaN])('rejects amount %s', async (amount) => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    await expect(adjust.execute(input(customer, { amount }))).rejects.toBeInstanceOf(
      InvalidOpsRequestError,
    );
  });

  it('rejects an unknown direction', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    await expect(adjust.execute(input(customer, { direction: 'SIDEWAYS' }))).rejects.toBeInstanceOf(
      InvalidOpsRequestError,
    );
  });

  it('rejects an unknown wallet', async () => {
    await expect(adjust.execute(input('nobody-aj'))).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
