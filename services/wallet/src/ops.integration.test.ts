import { randomUUID } from 'node:crypto';
import { validateEvent } from '@billing/contracts';
import { FakePaymentServer, createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyPaymentResult } from './application/apply-payment-result.js';
import { RunReconciliation } from './application/run-reconciliation.js';
import { startService, type RunningService } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { createHarness, expectLedgerInvariants, silentLogger, fundWallet } from './test-support.js';
import type { Harness } from './test-support.js';
import { FakeSettlement, startDay } from './test-support-reconciliation.js';
import { OrdersSimulator } from './test-support-orders.js';

let h: Harness;
let payment: FakePaymentServer;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
  payment = await FakePaymentServer.start();
});
afterAll(async () => {
  await payment.close();
  await h.close();
});

const configFor = (broker: TestBroker): WalletConfig => ({
  port: 0,
  database: h.config,
  tenants: [h.acme, h.beta],
  payment: { baseUrl: payment.baseUrl, webhookSecret: 'whsec_ops_e2e', timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  reconciliation: { autofix: true, atUtcHour: 23, maxAttempts: 3, maxItems: 1000 },
  topupBackoffSeconds: [1],
  workerIntervalMs: 50,
  retention: {
    enabled: false,
    dryRun: true,
    intervalMinutes: 60,
    maxSecondsPerRun: 60,
    batchSize: 1000,
    days: { outboxSent: 14, processedMessages: 30, idempotencyKeys: 90, reconciliation: 365 },
  },
  telemetry: { sampleIntervalSeconds: 15 },
});

const OPS = { 'x-tenant-id': 'acme', 'x-actor-id': 'ops1', 'x-actor-role': 'OPS' };
const newCustomer = () => `opsit${++counter}-${randomUUID().slice(0, 6)}`;
const key = () => `ops-it-${++counter}-${randomUUID()}`;
const reasonBody = (extra: Record<string, unknown> = {}) => ({
  reason: 'ticket 7',
  idempotencyKey: key(),
  ...extra,
});

const balance = async (customer: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema('t_acme')
        .selectFrom('accounts')
        .select('balance')
        .where('id', '=', `wallet:${customer}`)
        .executeTakeFirstOrThrow()
    ).balance,
  );
const ledgerTransactionCount = async (): Promise<number> =>
  (await h.db.withSchema('t_acme').selectFrom('ledger_transactions').select('id').execute()).length;

interface ActionItem {
  id: string;
  action: string;
  actor: string;
  target: string;
}

async function ops<T = Record<string, unknown>>(
  service: RunningService,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; json: T }> {
  const res = await service.app.inject({
    method,
    url,
    headers: OPS,
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, json: res.json<T>() };
}

/** Lấy các thao tác (mới nhất trước) có target thuộc `targets`. */
async function actionsFor(service: RunningService, targets: string[]): Promise<ActionItem[]> {
  const { json } = await ops<{ items: ActionItem[] }>(service, 'GET', '/ops/actions?limit=200');
  return json.items.filter((i) => targets.includes(i.target));
}

describe('ops tools over the real service and broker', () => {
  let broker: TestBroker;
  let orders: OrdersSimulator;
  let service: RunningService;

  beforeAll(async () => {
    broker = await createTestBroker('ops');
    orders = await OrdersSimulator.connect(broker.ecommerce);
    service = await startService(configFor(broker));
  });
  afterAll(async () => {
    await service.stop();
    await orders.close();
    await broker.drop();
  });

  const resultsOf = (orderId: string) => orders.resultsFor(orderId);
  const waitResults = (orderId: string, count: number) =>
    waitFor(() => resultsOf(orderId).length >= count, { timeoutMs: 20_000, intervalMs: 50 });

  it('rejects an order from a frozen wallet with WALLET_FROZEN, and pays a new order after unfreezing', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });

    const freeze = await ops<{ changed: boolean }>(
      service,
      'POST',
      `/ops/wallets/${customer}/freeze`,
      reasonBody(),
    );
    expect(freeze.status).toBe(200);
    expect(freeze.json.changed).toBe(true);

    const blocked = orders.ready({ customerId: customer, amount: 30000 });
    await orders.publish(blocked);
    await waitResults(blocked.orderId, 1);
    const [failed] = resultsOf(blocked.orderId);
    expect(failed?.type).toBe('OrderPaymentFailedV1');
    expect(validateEvent('OrderPaymentFailedV1', failed?.body).ok).toBe(true);
    expect(failed?.body.reason).toBe('WALLET_FROZEN');
    expect(await balance(customer)).toBe(100000);

    const unfreeze = await ops<{ changed: boolean }>(
      service,
      'POST',
      `/ops/wallets/${customer}/unfreeze`,
      reasonBody(),
    );
    expect(unfreeze.status).toBe(200);

    // Đơn bị từ chối không được nhớ: một order mới được trả bình thường.
    const next = orders.ready({ customerId: customer, amount: 30000 });
    await orders.publish(next);
    await waitResults(next.orderId, 1);
    expect(resultsOf(next.orderId)[0]?.type).toBe('OrderPaidV1');
    expect(await balance(customer)).toBe(70000);
  });

  it('replays the original OrderPaidV1 (same eventId) exactly once and leaves the ledger untouched', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = orders.ready({ customerId: customer, amount: 25000 });
    await orders.publish(event);
    await waitResults(event.orderId, 1);
    const original = resultsOf(event.orderId)[0]!;
    expect(original.type).toBe('OrderPaidV1');

    const txBefore = await ledgerTransactionCount();
    const replay = await ops<{ eventId: string }>(
      service,
      'POST',
      `/ops/orders/${event.orderId}/replay-paid`,
      reasonBody(),
    );
    expect(replay.status).toBe(202);
    expect(replay.json.eventId).toBe(original.body.eventId);

    await waitResults(event.orderId, 2);
    const [first, second] = resultsOf(event.orderId);
    expect(second?.type).toBe('OrderPaidV1');
    expect(second?.body.eventId).toBe(first?.body.eventId);
    // messageId của AMQP là id dòng outbox mới; consumer dedupe theo eventId trong payload.
    expect(second?.messageId).not.toBe(first?.messageId);
    expect(second?.body.walletTransactionId).toBe(first?.body.walletTransactionId);
    expect(second?.body.amount).toBe(first?.body.amount);

    // Chờ cho outbox xả hết rồi mới khẳng định không có bản thứ ba (điều kiện, không ngủ cố định).
    await waitFor(
      async () => {
        const pending = await h.db
          .withSchema('t_acme')
          .selectFrom('outbox')
          .select('id')
          .where('status', '=', 'PENDING')
          .execute();
        return pending.length === 0;
      },
      { timeoutMs: 20_000, intervalMs: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(resultsOf(event.orderId)).toHaveLength(2);
    expect(await ledgerTransactionCount()).toBe(txBefore);
    expect(await balance(customer)).toBe(75000);
  });

  it('adjusts then reverses a credit back to the original balance, with ordered actions by ops1, and reconciliation finds no internal discrepancy', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const before = await balance(customer);

    const freeze = await ops(service, 'POST', `/ops/wallets/${customer}/freeze`, reasonBody());
    expect(freeze.status).toBe(200);
    const adjust = await ops<{ transactionId: string }>(
      service,
      'POST',
      `/ops/wallets/${customer}/adjustments`,
      reasonBody({ direction: 'CREDIT', amount: 12345, currency: 'VND' }),
    );
    expect(adjust.status).toBe(201);
    expect(await balance(customer)).toBe(before + 12345);
    const txId = adjust.json.transactionId;
    const reversal = await ops(
      service,
      'POST',
      `/ops/transactions/${txId}/reversals`,
      reasonBody(),
    );
    expect(reversal.status).toBe(201);
    expect(await balance(customer)).toBe(before);
    await ops(service, 'POST', `/ops/wallets/${customer}/unfreeze`, reasonBody());
    await expectLedgerInvariants(h, h.acme);

    // Mới nhất trước: UNFREEZE, REVERSE, ADJUST, FREEZE.
    const items = await actionsFor(service, [`wallet:${customer}`, `transaction:${txId}`]);
    expect(items.map((i) => i.action)).toEqual(['UNFREEZE', 'REVERSE', 'ADJUST', 'FREEZE']);
    expect(items.every((i) => i.actor === 'ops1')).toBe(true);

    // Đối soát tenant có điều chỉnh/đảo: sổ cái nội bộ phải sạch.
    const settlement = new FakeSettlement();
    const day = startDay(h);
    settlement.set(day, []);
    const run = await new RunReconciliation({
      uow: h.uow,
      settlement,
      applyPayment: new ApplyPaymentResult({
        uow: h.uow,
        clock: h.clock,
        ids: h.ids,
        log: silentLogger,
      }),
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
      options: { autofix: true, maxItems: 1000 },
    }).execute({ tenant: h.acme, day, triggeredBy: 'MANUAL' });
    expect(run).toMatchObject({ status: 'COMPLETED', itemCount: 0 });
    const items2 = await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.listItems({ runId: run!.id, caseStatus: null, afterSeq: 0, limit: 50 }),
    );
    expect(
      items2.filter((i) => ['LEDGER_UNBALANCED', 'BALANCE_MISMATCH'].includes(i.kind)),
    ).toEqual([]);
  });

  it('keeps ops_actions across a service restart on the same database', async () => {
    const restartBroker = await createTestBroker('opsrestart');
    let first: RunningService | undefined;
    let second: RunningService | undefined;
    try {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 50000 });
      first = await startService(configFor(restartBroker));
      await ops(first, 'POST', `/ops/wallets/${customer}/freeze`, reasonBody());
      await ops(
        first,
        'POST',
        `/ops/wallets/${customer}/adjustments`,
        reasonBody({ direction: 'CREDIT', amount: 1000, currency: 'VND' }),
      );
      await first.stop();
      first = undefined;

      second = await startService(configFor(restartBroker));
      const items = await actionsFor(second, [`wallet:${customer}`]);
      expect(items.map((i) => i.action)).toEqual(['ADJUST', 'FREEZE']);
      expect(items.every((i) => i.actor === 'ops1')).toBe(true);
      // Trạng thái đóng băng cũng còn: đơn vẫn bị từ chối sau khi khởi động lại.
      const freezeAgain = await ops<{ changed: boolean }>(
        second,
        'POST',
        `/ops/wallets/${customer}/freeze`,
        reasonBody(),
      );
      expect(freezeAgain.json.changed).toBe(false);
    } finally {
      await first?.stop().catch(() => undefined);
      await second?.stop().catch(() => undefined);
      await restartBroker.drop();
    }
  }, 60_000);
});
