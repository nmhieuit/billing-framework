import { createDatabase } from '@billing/database';
import {
  FakeClock,
  FakePaymentServer,
  createTestBroker,
  createTestDatabase,
  waitFor,
  type TestBroker,
  type TestDatabase,
} from '@billing/testing';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CreateWallet } from './application/create-wallet.js';
import { RequestTopup } from './application/request-topup.js';
import { CustomerId } from './domain/customer-id.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { startService, type RunningService } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { TenantId } from './domain/tenant-id.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';

const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');

let testDb: TestDatabase;
let broker: TestBroker;
let db: Kysely<WalletDatabase>;
let fake: FakePaymentServer;
let clock: FakeClock;
let counter = 0;
const running: RunningService[] = [];
/** Sao kê giả của payment theo ngày. */
const settlements = new Map<string, unknown[]>();
/** Độ trễ của /settlements; chỉ test dừng service giữa chừng mới đặt > 0. */
let settlementDelayMs = 0;

beforeAll(async () => {
  testDb = await createTestDatabase('recsvc');
  broker = await createTestBroker('recsvc');
  db = createDatabase<WalletDatabase>(testDb.config);
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
  await broker.drop();
});
beforeEach(async () => {
  settlements.clear();
  settlementDelayMs = 0;
  clock = new FakeClock('2026-10-10T10:00:00.000Z');
  fake = await FakePaymentServer.start();
  fake.setFallback((number, request) => {
    const url = new URL(request.url, 'http://fake');
    if (url.pathname === '/settlements') {
      const date = url.searchParams.get('date') ?? '';
      return {
        status: 200,
        body: { date, items: settlements.get(date) ?? [], nextCursor: null, totals: [] },
        delayMs: settlementDelayMs,
      };
    }
    return { status: 202, body: { chargeId: `ch_e2e_${number}`, status: 'PENDING' } };
  });
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  settlementDelayMs = 0;
  await fake.close();
});

const configFor = (): WalletConfig => ({
  port: 0,
  database: testDb.config,
  tenants: [acme, beta],
  payment: { baseUrl: fake.baseUrl, webhookSecret: 'whsec_recsvc', timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  reconciliation: { autofix: true, atUtcHour: 0, maxAttempts: 3, maxItems: 1000 },
  topupBackoffSeconds: [1, 5],
  workerIntervalMs: 20,
});

async function start(): Promise<RunningService> {
  const service = await startService(configFor(), { clock });
  running.push(service);
  return service;
}

const operator = { 'x-tenant-id': 'acme' };
const caller = (customer: string) => ({ 'x-tenant-id': 'acme', 'x-customer-id': customer });
const topupRow = (topupId: string) =>
  db
    .withSchema('t_acme')
    .selectFrom('topups')
    .selectAll()
    .where('id', '=', topupId)
    .executeTakeFirstOrThrow();
const scheduledRuns = (tenant: 'acme' | 'beta', day: string) =>
  db
    .withSchema(`t_${tenant}`)
    .selectFrom('reconciliation_runs')
    .select('status')
    .where('run_day', '=', day)
    .where('triggered_by', '=', 'SCHEDULED')
    .execute();

describe('reconciliation in the running service', () => {
  it('credits a lost webhook exactly once when an operator runs the day by hand', async () => {
    const service = await start();
    const customer = `rec${++counter}`;
    const wallet = await service.app.inject({
      method: 'POST',
      url: '/wallets',
      headers: caller(customer),
      payload: { currency: 'VND' },
    });
    expect(wallet.statusCode).toBe(201);
    const created = await service.app.inject({
      method: 'POST',
      url: '/topups',
      headers: { ...caller(customer), 'idempotency-key': `key-${customer}` },
      payload: { amount: 150000 },
    });
    const { topupId } = created.json<{ topupId: string }>();
    await waitFor(async () => (await topupRow(topupId)).charge_id !== null);
    const chargeId = (await topupRow(topupId)).charge_id!;
    settlements.set('2026-10-10', [
      {
        chargeId,
        reference: topupId,
        amount: 150000,
        currency: 'VND',
        status: 'SUCCEEDED',
        metadata: { tenantId: 'acme' },
        completedAt: '2026-10-10T09:00:00.000Z',
      },
    ]);

    const started = await service.app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: operator,
      payload: { date: '2026-10-10' },
    });
    expect(started.statusCode).toBe(202);
    const { runId } = started.json<{ runId: string }>();
    await waitFor(async () => {
      const run = await service.app.inject({
        method: 'GET',
        url: `/reconciliations/${runId}`,
        headers: operator,
      });
      return run.json<{ status: string }>().status === 'COMPLETED';
    });

    const items = await service.app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items`,
      headers: operator,
    });
    expect(items.json<{ items: Array<{ kind: string; action: string }> }>().items).toMatchObject([
      { kind: 'MISSING_AT_WALLET', action: 'AUTO_APPLIED' },
    ]);
    const balance = await service.app.inject({
      method: 'GET',
      url: '/wallet',
      headers: caller(customer),
    });
    expect(balance.json<{ balance: number }>().balance).toBe(150000);
  });

  it('runs the daily task on its own: one scheduled run per tenant for yesterday, never repeated', async () => {
    await start();
    await waitFor(
      async () =>
        (await scheduledRuns('acme', '2026-10-09')).some((r) => r.status === 'COMPLETED') &&
        (await scheduledRuns('beta', '2026-10-09')).some((r) => r.status === 'COMPLETED'),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await scheduledRuns('acme', '2026-10-09')).toHaveLength(1);
    expect(await scheduledRuns('beta', '2026-10-09')).toHaveLength(1);
  });

  it('finishes a manual run that is still in flight when the service stops', async () => {
    settlementDelayMs = 600;
    const service = await start();
    const started = await service.app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: operator,
      payload: { date: '2026-10-08' },
    });
    const { runId } = started.json<{ runId: string }>();
    const statusOf = () =>
      db
        .withSchema('t_acme')
        .selectFrom('reconciliation_runs')
        .select('status')
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();

    // Chứng minh lượt chạy đang dở dang trước khi dừng service.
    expect((await statusOf()).status).toBe('RUNNING');

    await service.stop();

    expect((await statusOf()).status).toBe('COMPLETED');
  });

  it('keeps submitting topups while a slow daily reconciliation is still reading the settlement', async () => {
    settlementDelayMs = 3000;
    // Ngày khác với các test trên (chúng dùng chung database) để lượt định kỳ của hôm qua chưa có.
    clock.set('2026-11-10T10:00:00.000Z');
    await start();
    // Đối soát định kỳ đang bị chặn ở /settlements (chậm).
    await waitFor(() => fake.requests.some((r) => r.url.startsWith('/settlements')));

    // Lần nạp REQUESTED chỉ được Worker chính gửi (không có submitSoon vì tạo thẳng bằng use case).
    const uow = new KyselyTenantUnitOfWork(db);
    const customerId = CustomerId.parse(`slow${++counter}`);
    await new CreateWallet({ uow, clock }).execute({ tenant: acme, customerId, currency: 'VND' });
    const { body } = await new RequestTopup({
      uow,
      clock,
      ids: {
        topupId: () => `tp_${randomUUID()}`,
        transactionId: () => `tx_${randomUUID()}`,
        eventId: () => randomUUID(),
      },
      submitter: { submitSoon: () => undefined },
    }).execute({ tenant: acme, customerId, idempotencyKey: `slow-key-${counter}`, amount: 5000 });

    const begin = Date.now();
    await waitFor(async () => (await topupRow(body.topupId)).charge_id !== null);
    expect(Date.now() - begin).toBeLessThan(2000);
    expect((await topupRow(body.topupId)).status).toBe('PENDING');
  });
});
