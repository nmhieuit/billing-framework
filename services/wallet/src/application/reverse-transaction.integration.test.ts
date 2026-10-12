import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InsufficientFundsError } from '../domain/errors.js';
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
import {
  AlreadyReversedError,
  ReversalNotPossibleError,
  ReversalNotSupportedError,
  TransactionNotFoundError,
} from './errors.js';
import { FreezeWallet } from './freeze-wallet.js';
import { OpsActionRecorder } from './ops-recorder.js';
import { PayOrder } from './pay-order.js';
import { ReverseTransaction } from './reverse-transaction.js';

let h: Harness;
let reverse: ReverseTransaction;
let adjust: AdjustWallet;
let freeze: FreezeWallet;
let pay: PayOrder;
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
  reverse = new ReverseTransaction({ recorder, ids: h.ids });
  adjust = new AdjustWallet({ recorder, ids: h.ids });
  freeze = new FreezeWallet({ recorder });
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const newCustomer = () => `rv${++counter}`;
const request = (transactionId: string, overrides: Record<string, unknown> = {}) => ({
  tenant: h.acme,
  transactionId,
  actor: 'op@x',
  reason: 'customer complaint',
  idempotencyKey: `rv-key-${++counter}`,
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
const txCount = async (): Promise<number> =>
  (await h.db.withSchema(schema(h.acme)).selectFrom('ledger_transactions').select('id').execute())
    .length;
const payOrder = async (customer: string, amount = 50000) => {
  const orderId = randomUUID();
  const outcome = await pay.execute({
    tenant: h.acme,
    eventId: randomUUID(),
    correlationId: 'corr-1',
    orderId,
    customerId: customer,
    amount,
    currency: 'VND',
  });
  if (outcome.kind !== 'PAID') throw new Error('order not paid');
  return { orderId, transactionId: outcome.walletTransactionId };
};
const adjustCredit = async (customer: string, amount = 30000) =>
  (
    await adjust.execute({
      tenant: h.acme,
      customerId: customer,
      direction: 'CREDIT',
      amount,
      currency: 'VND',
      actor: 'op@x',
      reason: 'goodwill',
      idempotencyKey: `rv-adj-${++counter}`,
    })
  ).transactionId;

describe('ReverseTransaction', () => {
  it('reverses an order payment: wallet +amount, merchant -amount, original untouched', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { orderId, transactionId } = await payOrder(customer);
    const merchantBefore = await balance('system:MERCHANT:VND');
    const countBefore = await txCount();
    const originalEntries = () =>
      h.db
        .withSchema(schema(h.acme))
        .selectFrom('ledger_entries')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .execute();
    const entriesBefore = await originalEntries();

    const out = await reverse.execute(request(transactionId));

    expect(out.reversesTransactionId).toBe(transactionId);
    expect(await balance(`wallet:${customer}`)).toBe(100000);
    expect(await balance('system:MERCHANT:VND')).toBe(merchantBefore - 50000);
    expect(await txCount()).toBe(countBefore + 1);
    expect(await originalEntries()).toEqual(entriesBefore);
    const tx = await h.db
      .withSchema(schema(h.acme))
      .selectFrom('ledger_transactions')
      .selectAll()
      .where('id', '=', out.transactionId)
      .executeTakeFirstOrThrow();
    expect(tx).toMatchObject({
      kind: 'REVERSAL',
      reverses_transaction_id: transactionId,
      business_key: `reversal:${transactionId}`,
    });
    const paid = await h.db
      .withSchema(schema(h.acme))
      .selectFrom('order_payments')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute();
    expect(paid).toHaveLength(1);
  });

  it('refuses a second reversal with a different key', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { transactionId } = await payOrder(customer);
    await reverse.execute(request(transactionId));
    await expect(reverse.execute(request(transactionId))).rejects.toBeInstanceOf(
      AlreadyReversedError,
    );
    expect(await balance(`wallet:${customer}`)).toBe(100000);
  });

  it('serializes concurrent reversals with different keys: exactly one wins', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { transactionId } = await payOrder(customer);
    const merchantBefore = await balance('system:MERCHANT:VND');
    const settled = await Promise.allSettled([
      reverse.execute(request(transactionId)),
      reverse.execute(request(transactionId)),
      reverse.execute(request(transactionId)),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(AlreadyReversedError);
    }
    expect(await balance(`wallet:${customer}`)).toBe(100000);
    expect(await balance('system:MERCHANT:VND')).toBe(merchantBefore - 50000);
  });

  it.each([2, 5])(
    '%i concurrent reversals with the SAME key all fulfil with one identical result and one REVERSAL',
    async (count) => {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 100000 });
      const { transactionId } = await payOrder(customer);
      const merchantBefore = await balance('system:MERCHANT:VND');
      const countBefore = await txCount();
      const req = request(transactionId);
      const results = await Promise.all(Array.from({ length: count }, () => reverse.execute(req)));
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(await txCount()).toBe(countBefore + 1);
      expect(await balance(`wallet:${customer}`)).toBe(100000);
      expect(await balance('system:MERCHANT:VND')).toBe(merchantBefore - 50000);
      const audit = await h.db
        .withSchema(schema(h.acme))
        .selectFrom('ops_actions')
        .select('id')
        .where('idempotency_key', '=', req.idempotencyKey)
        .execute();
      expect(audit).toHaveLength(1);
    },
  );

  it('serializes concurrent reversals of an adjustment', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const adjustmentId = await adjustCredit(customer);
    const settled = await Promise.allSettled([
      reverse.execute(request(adjustmentId)),
      reverse.execute(request(adjustmentId)),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(AlreadyReversedError);
    }
    expect(await balance(`wallet:${customer}`)).toBe(100000);
  });

  it('reverses an adjustment credit back to the old balance', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const adjustmentId = await adjustCredit(customer);
    expect(await balance(`wallet:${customer}`)).toBe(130000);
    await reverse.execute(request(adjustmentId));
    expect(await balance(`wallet:${customer}`)).toBe(100000);
  });

  it('refuses to reverse an adjustment credit once the wallet has been spent', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 10000 });
    const adjustmentId = await adjustCredit(customer);
    await payOrder(customer, 40000);
    const countBefore = await txCount();
    const key = `rv-spent-${++counter}`;
    await expect(
      reverse.execute(request(adjustmentId, { idempotencyKey: key })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await txCount()).toBe(countBefore);
    expect(await balance(`wallet:${customer}`)).toBe(0);
    const audit = await h.db
      .withSchema(schema(h.acme))
      .selectFrom('ops_actions')
      .select('id')
      .where('idempotency_key', '=', key)
      .execute();
    expect(audit).toHaveLength(0);
  });

  it('refuses to reverse an order payment when the merchant balance cannot cover it', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { transactionId } = await payOrder(customer);
    const merchantBefore = await balance('system:MERCHANT:VND');
    const countBefore = await txCount();
    const key = `rv-nomerchant-${++counter}`;
    // Mô phỏng MERCHANT đã bị rút bớt; khôi phục ngay sau để bất biến sổ cái còn đúng.
    await h.db
      .withSchema(schema(h.acme))
      .updateTable('accounts')
      .set({ balance: 0 })
      .where('id', '=', 'system:MERCHANT:VND')
      .execute();
    try {
      await expect(
        reverse.execute(request(transactionId, { idempotencyKey: key })),
      ).rejects.toBeInstanceOf(ReversalNotPossibleError);
    } finally {
      await h.db
        .withSchema(schema(h.acme))
        .updateTable('accounts')
        .set({ balance: merchantBefore })
        .where('id', '=', 'system:MERCHANT:VND')
        .execute();
    }
    expect(await balance(`wallet:${customer}`)).toBe(50000);
    expect(await txCount()).toBe(countBefore);
    const audit = await h.db
      .withSchema(schema(h.acme))
      .selectFrom('ops_actions')
      .select('id')
      .where('idempotency_key', '=', key)
      .execute();
    expect(audit).toHaveLength(0);
  });

  it('reverses an adjustment debit: the wallet is credited back', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const debit = await adjust.execute({
      tenant: h.acme,
      customerId: customer,
      direction: 'DEBIT',
      amount: 30000,
      currency: 'VND',
      actor: 'op@x',
      reason: 'chargeback',
      idempotencyKey: `rv-adj-${++counter}`,
    });
    expect(await balance(`wallet:${customer}`)).toBe(70000);
    await reverse.execute(request(debit.transactionId));
    expect(await balance(`wallet:${customer}`)).toBe(100000);
  });

  it('does not support reversing a top-up or a reversal', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const topup = await h.db
      .withSchema(schema(h.acme))
      .selectFrom('ledger_transactions')
      .select('id')
      .where('kind', '=', 'TOPUP')
      .executeTakeFirstOrThrow();
    await expect(reverse.execute(request(topup.id))).rejects.toBeInstanceOf(
      ReversalNotSupportedError,
    );
    const adjustmentId = await adjustCredit(customer);
    const reversed = await reverse.execute(request(adjustmentId));
    await expect(reverse.execute(request(reversed.transactionId))).rejects.toBeInstanceOf(
      ReversalNotSupportedError,
    );
  });

  it('rejects an unknown transaction id', async () => {
    await expect(reverse.execute(request('tx_nope'))).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
  });

  it('replays the previous result for the same key without reversing twice', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { transactionId } = await payOrder(customer);
    const req = request(transactionId);
    const first = await reverse.execute(req);
    const countAfterFirst = await txCount();
    const second = await reverse.execute(req);
    expect(second).toEqual(first);
    expect(await txCount()).toBe(countAfterFirst);
    expect(await balance(`wallet:${customer}`)).toBe(100000);
  });

  it('works on a frozen wallet', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { transactionId } = await payOrder(customer);
    await freeze.execute({
      tenant: h.acme,
      customerId: customer,
      frozen: true,
      actor: 'op@x',
      reason: 'fraud check',
      idempotencyKey: `rv-fz-${++counter}`,
    });
    await reverse.execute(request(transactionId));
    expect(await balance(`wallet:${customer}`)).toBe(100000);
  });

  it('rejects a re-delivered order of a reversed payment with CONFLICT: no new OrderPaidV1 and no new debit', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const { orderId, transactionId } = await payOrder(customer);
    await reverse.execute(request(transactionId));
    const paidEvents = async () =>
      (
        await h.db
          .withSchema(schema(h.acme))
          .selectFrom('outbox')
          .select('id')
          .where('event_type', '=', 'OrderPaidV1')
          .where('payload', 'like', `%${orderId}%`)
          .execute()
      ).length;
    const paidBefore = await paidEvents();
    const countBefore = await txCount();
    const outcome = await pay.execute({
      tenant: h.acme,
      eventId: randomUUID(),
      correlationId: 'corr-2',
      orderId,
      customerId: customer,
      amount: 50000,
      currency: 'VND',
    });
    expect(outcome).toEqual({ kind: 'REJECTED', reason: 'CONFLICT' });
    expect(await balance(`wallet:${customer}`)).toBe(100000);
    expect(await txCount()).toBe(countBefore);
    expect(await paidEvents()).toBe(paidBefore);
  });
});
