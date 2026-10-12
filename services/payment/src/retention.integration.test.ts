import { createDatabase, migrate } from '@billing/database';
import {
  FakeClock,
  WebhookReceiver,
  createTestDatabase,
  waitFor,
  type TestDatabase,
} from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentMigrations } from '../../../db/payment/migrations.js';
import type { RetentionReport } from './application/retention.js';
import { startService, type RunningService } from './bootstrap.js';
import type { PaymentConfig } from './config.js';
import type { PaymentDatabase } from './infrastructure/kysely/schema.js';
import { RecordingMetrics } from './test-support-metrics.js';
import { resetTables } from './test-support.js';

const AGED = new Date('2026-01-01T00:00:00.000Z');
const YOUNG = new Date('2027-12-31T00:00:00.000Z');
const NEVER_DUE = new Date('2999-01-01T00:00:00.000Z');

let testDb: TestDatabase;
let db: Kysely<PaymentDatabase>;
let receiver: WebhookReceiver;
let clock: FakeClock;
let metrics: RecordingMetrics;
const running: RunningService[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase('payret');
  db = createDatabase<PaymentDatabase>(testDb.config);
  await migrate(db, paymentMigrations);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});
beforeEach(async () => {
  // Đồng hồ cố định ở 2028: mọi dòng ghi ngày 2026 đều đã quá hạn.
  clock = new FakeClock('2028-01-01T00:00:00.000Z');
  metrics = new RecordingMetrics();
  receiver = await WebhookReceiver.start();
  await resetTables(db);
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await receiver.close();
});

const configFor = (retention: Partial<PaymentConfig['retention']>): PaymentConfig => ({
  port: 0,
  database: testDb.config,
  webhook: { url: receiver.url, secret: 'whsec_payret', backoffSeconds: [1] },
  workerIntervalMs: 20,
  responseTimeoutMs: 150,
  retention: {
    enabled: true,
    dryRun: true,
    intervalMinutes: 1,
    maxSecondsPerRun: 60,
    batchSize: 1000,
    days: { webhook: 30, idempotencyKeys: 90 },
    ...retention,
  },
  telemetry: { sampleIntervalSeconds: 15 },
});

async function start(retention: Partial<PaymentConfig['retention']>): Promise<RunningService> {
  const service = await startService(configFor(retention), { clock, metrics });
  running.push(service);
  return service;
}

const insertCharge = (id: string, at: Date) =>
  db
    .insertInto('charges')
    .values({
      id,
      reference: `ref-${id}`,
      amount: 1000,
      currency: 'VND',
      status: 'SUCCEEDED',
      failure_code: null,
      scenario: '{}',
      metadata: null,
      due_at: at,
      created_at: at,
      completed_at: at,
    })
    .execute();

async function insertEvent(
  eventId: string,
  status: 'PENDING' | 'DELIVERED',
  at: Date,
  attempts: number,
): Promise<void> {
  await insertCharge(`ch-${eventId}`, at);
  await db
    .insertInto('webhook_events')
    .values({
      event_id: eventId,
      charge_id: `ch-${eventId}`,
      event_type: 'charge.succeeded',
      payload: '{}',
      status,
      attempts,
      // Sự kiện PENDING không bao giờ đến hạn để worker giao webhook không đổi trạng thái của nó.
      next_attempt_at: status === 'PENDING' ? NEVER_DUE : null,
      send_twice: false,
      created_at: at,
      delivered_at: status === 'DELIVERED' ? at : null,
    })
    .execute();
  for (let no = 1; no <= attempts; no += 1) {
    await db
      .insertInto('webhook_attempts')
      .values({
        event_id: eventId,
        attempt_no: no,
        attempted_at: at,
        status_code: 200,
        error_message: null,
      })
      .execute();
  }
}

const idempotencyRow = (key: string, chargeId: string, at: Date) =>
  db
    .insertInto('idempotency_keys')
    .values({
      idempotency_key: key,
      request_hash: 'h',
      response_status: 202,
      response_body: '{}',
      charge_id: chargeId,
      created_at: at,
    })
    .execute();

async function seed(): Promise<void> {
  await insertEvent('evt_aged', 'DELIVERED', AGED, 2);
  await insertEvent('evt_pending_old', 'PENDING', AGED, 1);
  await insertEvent('evt_young', 'DELIVERED', YOUNG, 1);
  await idempotencyRow('key_aged', 'ch-evt_aged', AGED);
  await idempotencyRow('key_young', 'ch-evt_young', YOUNG);
}

const ids = async (table: 'webhook_events' | 'idempotency_keys' | 'charges') => {
  const column =
    table === 'webhook_events' ? 'event_id' : table === 'charges' ? 'id' : 'idempotency_key';
  const result = await sql<{ id: string }>`
    select ${sql.id(column)} as id from ${sql.id(table)} order by 1`.execute(db);
  return result.rows.map((r) => r.id);
};
const attemptEvents = async () =>
  [
    ...new Set(
      (await db.selectFrom('webhook_attempts').select('event_id').execute()).map((r) => r.event_id),
    ),
  ].sort();

const retentionReports = (): RetentionReport[] =>
  metrics.calls
    .filter(([method]) => method === 'retentionRun')
    .map(([, report]) => report as RetentionReport);

describe('retention worker in the running payment service', () => {
  it('only counts by default (dry run) and leaves every row in place', async () => {
    await seed();
    await start({ dryRun: true });

    await waitFor(() => retentionReports().length > 0, { timeoutMs: 15_000 });
    const report = retentionReports()[0]!;
    expect(report.dryRun).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.rows).toContainEqual({ table: 'webhook_attempts', count: 2 });
    // Chạy thử không xóa attempt nên chưa có event nào đủ điều kiện (còn attempt tham chiếu).
    expect(report.rows.map((r) => r.table)).not.toContain('webhook_events');
    expect(report.rows).toContainEqual({ table: 'idempotency_keys', count: 1 });
    expect(await ids('webhook_events')).toEqual(['evt_aged', 'evt_pending_old', 'evt_young']);
    expect(await ids('idempotency_keys')).toEqual(['key_aged', 'key_young']);
    expect(await attemptEvents()).toEqual(['evt_aged', 'evt_pending_old', 'evt_young']);
  });

  it('really deletes aged rows when dry run is off, and never touches charges', async () => {
    await seed();
    const chargesBefore = await ids('charges');
    expect(chargesBefore).toHaveLength(3);
    await start({ dryRun: false });

    await waitFor(() => retentionReports().length > 0, { timeoutMs: 15_000 });
    const report = retentionReports()[0]!;
    expect(report.dryRun).toBe(false);
    expect(report.errors).toBe(0);
    expect(await ids('webhook_events')).toEqual(['evt_pending_old', 'evt_young']);
    expect(await attemptEvents()).toEqual(['evt_pending_old', 'evt_young']);
    expect(await ids('idempotency_keys')).toEqual(['key_young']);
    expect(await ids('charges')).toEqual(chargesBefore);
  });

  it('starts no worker when retention is disabled', async () => {
    await seed();
    await start({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(retentionReports()).toHaveLength(0);
    expect(await ids('webhook_events')).toEqual(['evt_aged', 'evt_pending_old', 'evt_young']);
  });

  it('stop() waits for a retention run that is in flight', async () => {
    await seed();
    // Khóa độc quyền bảng idempotency_keys: chỉ lượt dọn chạm bảng này (không có request nào tạo charge),
    // nên chỉ retentionWorker.stop() mới có thể là bước đang chờ trong service.stop().
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction().execute(async (trx) => {
      await sql`select top (1) idempotency_key from idempotency_keys with (tablockx, holdlock)`.execute(
        trx,
      );
      locked();
      await gate;
    });
    let stopping: Promise<void> | undefined;
    try {
      await Promise.race([lockTaken, holder]);
      const service = await start({ dryRun: true });
      const url = await service.app.listen({ port: 0, host: '127.0.0.1' });
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
