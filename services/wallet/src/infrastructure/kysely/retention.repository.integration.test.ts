import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayOrder } from '../../application/pay-order.js';
import {
  WALLET_RETENTION_POLICIES,
  type WalletRetentionPolicy,
} from '../../application/retention.js';
import type { TenantId } from '../../domain/tenant-id.js';
import {
  createHarness,
  fundWallet,
  seedTopup,
  silentLogger,
  type Harness,
} from '../../test-support.js';
import { RETENTION_TARGET_TABLES } from './retention.repository.js';

let h: Harness;
let counter = 0;

const CUTOFF = new Date('2026-06-01T00:00:00Z');
const OLD = new Date('2026-01-01T00:00:00Z');
const YOUNG = new Date('2026-07-01T00:00:00Z');
const FAR_FUTURE = new Date('2999-01-01T00:00:00Z');
const FINANCIAL_TABLES = [
  'ledger_transactions',
  'ledger_entries',
  'accounts',
  'topups',
  'order_payments',
] as const;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
// Các policy xóa theo ngưỡng thời gian trên toàn schema, nên mỗi test bắt đầu từ bảng retention rỗng
// (chỉ xóa 5 bảng retention, không đụng bảng tài chính) để kết quả đếm chính xác và test độc lập.
beforeEach(async () => {
  for (const tenant of ['t_acme', 't_beta']) {
    const db = h.db.withSchema(tenant);
    await db.deleteFrom('reconciliation_items').execute();
    await db.deleteFrom('reconciliation_runs').execute();
    await db.deleteFrom('outbox').execute();
    await db.deleteFrom('processed_messages').execute();
    await db.deleteFrom('idempotency_keys').execute();
  }
});

const purge = (
  policy: WalletRetentionPolicy,
  options: { tenant?: TenantId; cutoff?: Date; batch?: number; dryRun?: boolean } = {},
) =>
  h.uow.run(options.tenant ?? h.acme, ({ retention }) =>
    retention.purge(
      policy,
      options.cutoff ?? CUTOFF,
      options.batch ?? 1000,
      options.dryRun ?? false,
    ),
  );

/** Xóa từng lô đến khi hết dòng đủ điều kiện; trả tổng số đã xóa. */
const purgeAll = async (
  policy: WalletRetentionPolicy,
  options: { tenant?: TenantId; cutoff?: Date } = {},
): Promise<number> => {
  let total = 0;
  for (;;) {
    const n = await purge(policy, { ...options, batch: 7 });
    if (n === 0) return total;
    total += n;
  }
};

const insertOutbox = async (
  rows: Array<{ id: string; status: 'PENDING' | 'SENT'; created: Date; sent: Date | null }>,
  schema = 't_acme',
) =>
  h.db
    .withSchema(schema)
    .insertInto('outbox')
    .values(
      rows.map((r) => ({
        id: r.id,
        event_type: 'OrderPaidV1',
        routing_key: 'order-paid.v1',
        payload: '{}',
        correlation_id: 'corr',
        status: r.status,
        attempts: 0,
        next_attempt_at: r.created,
        created_at: r.created,
        sent_at: r.sent,
      })),
    )
    .execute();

const outboxIds = async (schema = 't_acme') =>
  (await h.db.withSchema(schema).selectFrom('outbox').select('id').execute())
    .map((r) => r.id)
    .sort();

const agedSent = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    status: 'SENT' as const,
    created: OLD,
    sent: OLD,
  }));

const countOf = async (table: string, schema = 't_acme') =>
  Number(
    (await sql<{ n: number }>`select count(*) as n from ${sql.id(schema, table)}`.execute(h.db))
      .rows[0]?.n,
  );

describe('outbox_sent', () => {
  it('deletes only old SENT rows and is idempotent', async () => {
    await insertOutbox([
      { id: 'sent-old', status: 'SENT', created: OLD, sent: OLD },
      { id: 'sent-young', status: 'SENT', created: YOUNG, sent: YOUNG },
      { id: 'pending-old', status: 'PENDING', created: OLD, sent: null },
      { id: 'pending-young', status: 'PENDING', created: YOUNG, sent: null },
    ]);
    expect(await purge('outbox_sent')).toBe(1);
    expect(await outboxIds()).toEqual(['pending-old', 'pending-young', 'sent-young']);
    expect(await purge('outbox_sent')).toBe(0);
  });
});

describe('processed_messages', () => {
  it('deletes old rows of every consumer and keeps young ones', async () => {
    await h.db
      .withSchema('t_acme')
      .insertInto('processed_messages')
      .values([
        { consumer: 'orders-events', message_id: 'm-old', processed_at: OLD },
        { consumer: 'orders-events', message_id: 'm-young', processed_at: YOUNG },
        { consumer: 'payment-webhook', message_id: 'm-old', processed_at: OLD },
        { consumer: 'payment-webhook', message_id: 'm-young', processed_at: YOUNG },
      ])
      .execute();
    expect(await purge('processed_messages')).toBe(2);
    const left = await h.db
      .withSchema('t_acme')
      .selectFrom('processed_messages')
      .selectAll()
      .execute();
    expect(left.map((r) => `${r.consumer}/${r.message_id}`).sort()).toEqual([
      'orders-events/m-young',
      'payment-webhook/m-young',
    ]);
  });
});

describe('idempotency_keys', () => {
  it('deletes only aged keys and leaves the topups they point to', async () => {
    const aged = [await seedTopup(h), await seedTopup(h)];
    const young = await seedTopup(h);
    await h.db
      .withSchema('t_acme')
      .updateTable('idempotency_keys')
      .set({ created_at: OLD })
      .where(
        'topup_id',
        'in',
        aged.map((a) => a.topupId),
      )
      .execute();
    await h.db
      .withSchema('t_acme')
      .updateTable('idempotency_keys')
      .set({ created_at: YOUNG })
      .where('topup_id', '=', young.topupId)
      .execute();
    const topupsBefore = await countOf('topups');

    expect(await purge('idempotency_keys')).toBe(2);

    const left = await h.db
      .withSchema('t_acme')
      .selectFrom('idempotency_keys')
      .select('topup_id')
      .execute();
    expect(left.map((r) => r.topup_id)).toEqual([young.topupId]);
    expect(await countOf('topups')).toBe(topupsBefore);
  });
});

describe('reconciliation_items / reconciliation_runs', () => {
  const item = (id: string, action: 'AUTO_APPLIED' | 'NONE') => ({
    id,
    kind: 'MISSING_AT_WALLET' as const,
    chargeId: `ch_${id}`,
    topupId: `tp_${id}`,
    amountGateway: 1000,
    amountWallet: 1000,
    currency: 'VND',
    detail: {},
    action,
  });
  const makeRun = async (
    id: string,
    day: string,
    state: 'COMPLETED' | 'FAILED' | 'RUNNING',
    items: ReturnType<typeof item>[] = [],
  ) => {
    await h.uow.run(h.acme, async ({ reconciliation }) => {
      await reconciliation.startRun({ id, day, triggeredBy: 'MANUAL', startedAt: OLD });
      if (state === 'COMPLETED') {
        await reconciliation.completeRun(id, {
          gatewayTotals: {},
          walletTotals: {},
          items,
          finishedAt: OLD,
        });
      } else if (state === 'FAILED') {
        await reconciliation.failRun(id, 'boom', OLD);
      }
    });
  };
  const setItemAge = (id: string, at: Date) =>
    h.db
      .withSchema('t_acme')
      .updateTable('reconciliation_items')
      .set({ created_at: at })
      .where('id', '=', id)
      .execute();

  it('purges closed items first, then only the runs left without items', async () => {
    // Lượt A: một dòng RESOLVED cũ (AUTO_APPLIED) + một dòng OPEN cũ.
    await makeRun('run-a', '2026-01-01', 'COMPLETED', [
      item('a-res', 'AUTO_APPLIED'),
      item('a-open', 'NONE'),
    ]);
    // Lượt B: chỉ một dòng RESOLVED cũ.
    await makeRun('run-b', '2026-01-02', 'COMPLETED', [item('b-res', 'AUTO_APPLIED')]);
    // Lượt C: FAILED cũ, không có dòng nào. Lượt D: còn RUNNING.
    await makeRun('run-c', '2026-01-03', 'FAILED');
    await makeRun('run-d', '2026-01-04', 'RUNNING');
    // Lượt E: COMPLETED còn trẻ.
    await h.uow.run(h.acme, async ({ reconciliation }) => {
      await reconciliation.startRun({
        id: 'run-e',
        day: '2026-07-01',
        triggeredBy: 'MANUAL',
        startedAt: YOUNG,
      });
      await reconciliation.completeRun('run-e', {
        gatewayTotals: {},
        walletTotals: {},
        items: [],
        finishedAt: YOUNG,
      });
    });
    await setItemAge('a-res', OLD);
    await setItemAge('a-open', OLD);
    await setItemAge('b-res', OLD);

    // Chưa xóa dòng thì lượt B/A vẫn còn dòng nên chỉ lượt C đủ điều kiện.
    expect(await purge('reconciliation_runs', { dryRun: true })).toBe(1);

    expect(await purgeAll('reconciliation_items')).toBe(2);
    const items = await h.db
      .withSchema('t_acme')
      .selectFrom('reconciliation_items')
      .select('id')
      .execute();
    expect(items.map((r) => r.id)).toEqual(['a-open']);

    expect(await purgeAll('reconciliation_runs')).toBe(2);
    const runs = await h.db
      .withSchema('t_acme')
      .selectFrom('reconciliation_runs')
      .select('id')
      .execute();
    expect(runs.map((r) => r.id).sort()).toEqual(['run-a', 'run-d', 'run-e']);
  });
});

describe('reconciliation_items age basis', () => {
  const setItem = (
    id: string,
    set: { created_at: Date; case_status: string; resolved_at: Date | null },
  ) =>
    h.db
      .withSchema('t_acme')
      .updateTable('reconciliation_items')
      .set(set)
      .where('id', '=', id)
      .execute();
  const itemIds = async () =>
    (await h.db.withSchema('t_acme').selectFrom('reconciliation_items').select('id').execute())
      .map((r) => r.id)
      .sort();
  const seedItems = async (ids: string[]) => {
    await h.uow.run(h.acme, async ({ reconciliation }) => {
      await reconciliation.startRun({
        id: 'run-age',
        day: '2026-01-01',
        triggeredBy: 'MANUAL',
        startedAt: OLD,
      });
      await reconciliation.completeRun('run-age', {
        gatewayTotals: {},
        walletTotals: {},
        items: ids.map((id) => ({
          id,
          kind: 'MISSING_AT_WALLET' as const,
          chargeId: `ch_${id}`,
          topupId: `tp_${id}`,
          amountGateway: 1000,
          amountWallet: 1000,
          currency: 'VND',
          detail: {},
          action: 'NONE' as const,
        })),
        finishedAt: OLD,
      });
    });
  };

  it('keeps a long-open case resolved after the cutoff, deletes old resolved/ignored ones', async () => {
    await seedItems(['resolved-young', 'ignored-old', 'resolved-old', 'resolved-null']);
    await setItem('resolved-young', {
      created_at: OLD,
      case_status: 'RESOLVED',
      resolved_at: YOUNG,
    });
    await setItem('ignored-old', { created_at: OLD, case_status: 'IGNORED', resolved_at: OLD });
    await setItem('resolved-old', { created_at: OLD, case_status: 'RESOLVED', resolved_at: OLD });
    await setItem('resolved-null', { created_at: OLD, case_status: 'RESOLVED', resolved_at: null });
    expect(await purge('reconciliation_items', { dryRun: true })).toBe(3);
    expect(await purge('reconciliation_items')).toBe(3);
    expect(await itemIds()).toEqual(['resolved-young']);
  });

  it('keeps an item exactly at the cutoff (strict <)', async () => {
    await seedItems(['edge']);
    await setItem('edge', { created_at: CUTOFF, case_status: 'RESOLVED', resolved_at: CUTOFF });
    expect(await purge('reconciliation_items')).toBe(0);
    expect(await itemIds()).toEqual(['edge']);
  });

  it('keeps a non-RUNNING run whose finished_at is NULL', async () => {
    await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.startRun({
        id: 'run-null',
        day: '2026-01-05',
        triggeredBy: 'MANUAL',
        startedAt: OLD,
      }),
    );
    await h.db
      .withSchema('t_acme')
      .updateTable('reconciliation_runs')
      .set({ status: 'FAILED', finished_at: null })
      .where('id', '=', 'run-null')
      .execute();
    expect(await purge('reconciliation_runs')).toBe(0);
    expect(await countOf('reconciliation_runs')).toBe(1);
  });
});

describe('batching and dry-run', () => {
  it('honours the batch size (TOP)', async () => {
    await insertOutbox(agedSent('batch', 25));
    expect(await purge('outbox_sent', { batch: 10 })).toBe(10);
    expect(await purge('outbox_sent', { batch: 10 })).toBe(10);
    expect(await purge('outbox_sent', { batch: 10 })).toBe(5);
    expect(await purge('outbox_sent', { batch: 10 })).toBe(0);
  });

  it('counts without deleting in dry-run, regardless of the batch size', async () => {
    await insertOutbox(agedSent('dry', 25));
    expect(await purge('outbox_sent', { batch: 10, dryRun: true })).toBe(25);
    expect(await countOf('outbox')).toBe(25);
    expect(await purge('processed_messages', { dryRun: true })).toBe(0);
  });
});

describe('safety', () => {
  it('never touches the financial tables, even with a far-future cutoff', async () => {
    const customer = `fin${++counter}`;
    await fundWallet(h, { customer, amount: 100000 });
    const paid = await new PayOrder({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
    }).execute({
      tenant: h.acme,
      eventId: randomUUID(),
      correlationId: 'corr-fin',
      orderId: randomUUID(),
      customerId: customer,
      amount: 40000,
      currency: 'VND',
    });
    expect(paid.kind).toBe('PAID');
    await insertOutbox(agedSent('fin', 3));

    const before: Record<string, number> = {};
    for (const table of FINANCIAL_TABLES) before[table] = await countOf(table);
    for (const table of FINANCIAL_TABLES) expect(before[table], table).toBeGreaterThan(0);

    for (const policy of WALLET_RETENTION_POLICIES) {
      await purgeAll(policy, { cutoff: FAR_FUTURE });
    }

    for (const table of FINANCIAL_TABLES) expect(await countOf(table), table).toBe(before[table]);
    expect(await countOf('outbox')).toBe(1); // chỉ dòng PENDING do PayOrder tạo còn lại
  });

  it('keeps the policy list in foreign-key order and out of financial tables', () => {
    expect(WALLET_RETENTION_POLICIES).toEqual([
      'reconciliation_items',
      'reconciliation_runs',
      'outbox_sent',
      'processed_messages',
      'idempotency_keys',
    ]);
    const touched = Object.values(RETENTION_TARGET_TABLES).flat();
    for (const table of FINANCIAL_TABLES) expect(touched).not.toContain(table);
  });

  it('survives two concurrent purges without deadlock and deletes each row once', async () => {
    await insertOutbox(agedSent('par', 200));
    const results = await Promise.all([
      purgeAll('outbox_sent', { cutoff: CUTOFF }),
      purgeAll('outbox_sent', { cutoff: CUTOFF }),
    ]);
    expect(results[0] + results[1]).toBe(200);
    expect(await countOf('outbox')).toBe(0);
  });

  it('isolates tenants', async () => {
    await insertOutbox(agedSent('acme', 2));
    await insertOutbox(agedSent('beta', 3), 't_beta');
    expect(await purgeAll('outbox_sent')).toBe(2);
    expect(await outboxIds('t_beta')).toEqual(['beta-0', 'beta-1', 'beta-2']);
  });
});
