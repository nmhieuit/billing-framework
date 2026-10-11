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
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startService, type RunningService } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import type { RetentionReport } from './application/retention.js';
import { TenantId } from './domain/tenant-id.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { ConfigTenantRegistry } from './infrastructure/tenant-registry.js';
import { RecordingMetrics } from './test-support-metrics.js';
import { SequentialIds, fundWallet, type Harness } from './test-support.js';

const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');
const AGED = new Date('2026-01-01T00:00:00.000Z');
const YOUNG = new Date('2027-12-31T00:00:00.000Z');

let testDb: TestDatabase;
let broker: TestBroker;
let db: Kysely<WalletDatabase>;
let fake: FakePaymentServer;
let clock: FakeClock;
let metrics: RecordingMetrics;
const running: RunningService[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase('retsvc');
  broker = await createTestBroker('retsvc');
  db = createDatabase<WalletDatabase>(testDb.config);
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
  await seedFinancialRows();
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
  await broker.drop();
});
beforeEach(async () => {
  // Đồng hồ cố định ở 2028: mọi dòng ghi ngày 2026 đều đã quá hạn.
  clock = new FakeClock('2028-01-01T00:00:00.000Z');
  metrics = new RecordingMetrics();
  fake = await FakePaymentServer.start();
  fake.setFallback(() => ({ status: 202, body: { chargeId: 'ch_ret', status: 'PENDING' } }));
  await db.withSchema('t_acme').deleteFrom('outbox').execute();
  await db.withSchema('t_acme').deleteFrom('processed_messages').execute();
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await fake.close();
});

const configFor = (retention: Partial<WalletConfig['retention']>): WalletConfig => ({
  port: 0,
  database: testDb.config,
  tenants: [acme, beta],
  payment: { baseUrl: fake.baseUrl, webhookSecret: 'whsec_retsvc', timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  reconciliation: { autofix: true, atUtcHour: 0, maxAttempts: 3, maxItems: 1000 },
  topupBackoffSeconds: [1, 5],
  workerIntervalMs: 20,
  retention: {
    enabled: true,
    dryRun: true,
    intervalMinutes: 1,
    maxSecondsPerRun: 60,
    batchSize: 1000,
    days: { outboxSent: 14, processedMessages: 30, idempotencyKeys: 90, reconciliation: 365 },
    ...retention,
  },
  telemetry: { sampleIntervalSeconds: 15 },
});

async function start(retention: Partial<WalletConfig['retention']>): Promise<RunningService> {
  const service = await startService(configFor(retention), { clock, metrics });
  running.push(service);
  return service;
}

const outboxRow = (id: string, sentAt: Date) =>
  db
    .withSchema('t_acme')
    .insertInto('outbox')
    .values({
      id,
      event_type: 'wallet.order-paid',
      routing_key: 'wallet.order-paid',
      payload: '{}',
      correlation_id: id,
      status: 'SENT',
      attempts: 1,
      next_attempt_at: sentAt,
      created_at: sentAt,
      sent_at: sentAt,
    })
    .execute();
const processedRow = (id: string, at: Date) =>
  db
    .withSchema('t_acme')
    .insertInto('processed_messages')
    .values({ consumer: 'order-payments', message_id: id, processed_at: at })
    .execute();

/** Một ví đã nạp tiền và một order đã trả, để các bảng tài chính không rỗng. */
async function seedFinancialRows(): Promise<void> {
  const harness = {
    db,
    clock: new FakeClock('2028-01-01T00:00:00.000Z'),
    ids: new SequentialIds(),
    uow: new KyselyTenantUnitOfWork(db),
    registry: new ConfigTenantRegistry([acme, beta]),
    acme,
    beta,
  } as unknown as Harness;
  await fundWallet(harness, { customer: 'retcust', amount: 100000 });
  await db
    .withSchema('t_acme')
    .insertInto('ledger_transactions')
    .values({
      id: 'tx_ret_order',
      business_key: 'order:ret_order',
      kind: 'ORDER_PAYMENT',
      created_at: AGED,
    })
    .execute();
  await db
    .withSchema('t_acme')
    .insertInto('order_payments')
    .values({
      order_id: 'ret_order',
      customer_id: 'retcust',
      wallet_transaction_id: 'tx_ret_order',
      amount: 5000,
      currency: 'VND',
      paid_at: AGED,
    })
    .execute();
}

async function seed(): Promise<void> {
  await outboxRow('ob_aged', AGED);
  await outboxRow('ob_young', YOUNG);
  await processedRow('pm_aged', AGED);
  await processedRow('pm_young', YOUNG);
}

async function financialCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [
    'topups',
    'ledger_transactions',
    'ledger_entries',
    'order_payments',
    'accounts',
  ]) {
    const result = await sql<{ n: number }>`
      select count(*) as n from ${sql.id('t_acme', table)}`.execute(db);
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

const outboxIds = async () =>
  (await db.withSchema('t_acme').selectFrom('outbox').select('id').orderBy('id').execute()).map(
    (r) => r.id,
  );
const processedIds = async () =>
  (
    await db
      .withSchema('t_acme')
      .selectFrom('processed_messages')
      .select('message_id')
      .orderBy('message_id')
      .execute()
  ).map((r) => r.message_id);

const retentionReports = (): RetentionReport[] =>
  metrics.calls
    .filter(([method]) => method === 'retentionRun')
    .map(([, report]) => report as RetentionReport);

describe('retention worker in the running service', () => {
  it('only counts by default (dry run) and leaves every row in place', async () => {
    await seed();
    await start({ dryRun: true });

    await waitFor(() => retentionReports().length > 0, { timeoutMs: 15_000 });
    const report = retentionReports()[0]!;
    expect(report.dryRun).toBe(true);
    expect(report.rows).toContainEqual({ tenant: 'acme', table: 'outbox_sent', count: 1 });
    expect(report.rows).toContainEqual({ tenant: 'acme', table: 'processed_messages', count: 1 });
    expect(await outboxIds()).toEqual(['ob_aged', 'ob_young']);
    expect(await processedIds()).toEqual(['pm_aged', 'pm_young']);
  });

  it('really deletes aged rows when dry run is off, and never touches financial tables', async () => {
    await seed();
    const before = await financialCounts();
    expect(before.topups).toBeGreaterThan(0);
    expect(before.order_payments).toBe(1);
    await start({ dryRun: false });

    await waitFor(() => retentionReports().length > 0, { timeoutMs: 15_000 });
    const report = retentionReports()[0]!;
    expect(report.dryRun).toBe(false);
    expect(report.errors).toBe(0);
    expect(await outboxIds()).toEqual(['ob_young']);
    expect(await processedIds()).toEqual(['pm_young']);
    expect(await financialCounts()).toEqual(before);
  });

  it('starts no worker when retention is disabled', async () => {
    await seed();
    await start({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(retentionReports()).toHaveLength(0);
    expect(await outboxIds()).toEqual(['ob_aged', 'ob_young']);
  });

  it('stop() waits for a retention run that is in flight', async () => {
    await seed();
    // Khóa độc quyền bảng processed_messages của acme: chỉ lượt dọn chạm bảng này (consumer không nhận tin nào),
    // nên chỉ retentionWorker.stop() mới có thể là bước đang chờ trong service.stop().
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction().execute(async (trx) => {
      await sql`select top (1) message_id from ${sql.id('t_acme', 'processed_messages')} with (tablockx, holdlock)`.execute(
        trx,
      );
      locked();
      await gate;
    });
    let stopping: Promise<void> | undefined;
    try {
      await Promise.race([lockTaken, holder]);
      const service = await start({ dryRun: true });
      await service.app.listen({ port: 0, host: '127.0.0.1' });
      const url = await service.app.getUrl();
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(retentionReports()).toHaveLength(0); // lượt đang kẹt

      let stopped = false;
      stopping = service.stop().then(() => void (stopped = true));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(stopped).toBe(false); // stop() phải chờ lượt đang chạy
      // Các bước sau retentionWorker.stop() (app.close, db.destroy) chưa được chạy: HTTP vẫn nhận kết nối.
      // Nếu stop() của Worker không chờ lượt đang chạy, app.close() sẽ chạy ngay và kết nối bị từ chối.
      await expect(fetch(`${url}/nope`)).resolves.toBeInstanceOf(Response);

      release();
      await stopping;
      // Lượt đang chạy được chạy nốt (và báo cáo) trước khi stop() trả về.
      expect(retentionReports()).toHaveLength(1);
      const afterStop = metrics.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(metrics.calls).toHaveLength(afterStop);
    } finally {
      release();
      await stopping?.catch(() => undefined);
      await holder;
    }
  });
});
