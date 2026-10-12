import { createDatabase, dateTime, migrate } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { walletMigrations } from './migrations/index.js';
import { provisionTenants } from './provisioning.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;
let firstRun: Record<string, string[]>;
const when = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));

beforeAll(async () => {
  testDb = await createTestDatabase('opsmig');
  db = createDatabase<unknown>(testDb.config);
  firstRun = await provisionTenants(db, [TenantId.parse('acme')]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const t = (name: string) => sql.id('t_acme', name);
/** Chạy câu lệnh dự kiến thất bại và trả về thông điệp lỗi (chuỗi rỗng nếu thành công, để assert fail rõ ràng). */
const failure = async (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const insertAccount = (id: string, kind: string, balance: number, frozen = false) =>
  sql`insert into ${t('accounts')} (id, kind, customer_id, currency, balance, created_at, frozen_at)
    values (${id}, ${kind}, null, 'VND', ${balance}, ${when()}, ${frozen ? when() : null})`.execute(
    db,
  );

const insertTransaction = (id: string, kind: string, reverses: string | null = null) =>
  sql`insert into ${t('ledger_transactions')} (id, business_key, kind, created_at, reverses_transaction_id)
    values (${id}, ${`bk:${id}`}, ${kind}, ${when()}, ${reverses})`.execute(db);

describe('007-ops-tools', () => {
  it('is applied on first provisioning and idempotent afterwards', async () => {
    // Lần provision đầu (beforeAll) phải đã áp dụng migration 007; lần hai không áp dụng gì thêm.
    expect(firstRun.acme).toContain('007-ops-tools');
    expect(await provisionTenants(db, [TenantId.parse('acme')])).toEqual({ acme: [] });
  });

  it('adds nullable freeze columns that only wallets may use', async () => {
    const cols = await sql<{ name: string; is_nullable: boolean }>`
      select c.name, c.is_nullable from sys.columns c
      join sys.tables tb on tb.object_id = c.object_id
      join sys.schemas s on s.schema_id = tb.schema_id
      where s.name = 't_acme' and tb.name = 'accounts' and c.name like 'frozen[_]%'`.execute(db);
    expect(cols.rows.map((r) => r.name).sort()).toEqual([
      'frozen_at',
      'frozen_by',
      'frozen_reason',
    ]);
    expect(cols.rows.every((r) => r.is_nullable)).toBe(true);

    await insertAccount('w:frozen-ok', 'WALLET', 5, true);
    expect(await failure(insertAccount('x:gw-frozen', 'GATEWAY', 0, true))).toContain(
      'ck_accounts_frozen',
    );
    expect(
      await failure(
        sql`update ${t('accounts')} set frozen_at = ${when()} where id = 'system:GATEWAY:VND'`.execute(
          db,
        ),
      ),
    ).toContain('ck_accounts_frozen');
  });

  it('accepts ADJUSTMENT accounts of either sign but still rejects a negative wallet', async () => {
    await insertAccount('x:adj-neg', 'ADJUSTMENT', -100);
    await insertAccount('x:adj-pos', 'ADJUSTMENT', 100);
    expect(await failure(insertAccount('w:negative', 'WALLET', -1))).toContain(
      'ck_accounts_balance',
    );
    expect(await failure(insertAccount('x:unknown', 'OTHER', 0))).toContain('ck_accounts_kind');
  });

  it('seeds zero-balance system ADJUSTMENT accounts for both currencies', async () => {
    const rows = await sql<{ id: string; kind: string; currency: string; balance: string }>`
      select id, kind, currency, balance from ${t('accounts')}
      where id like 'system:ADJUSTMENT:%' order by id`.execute(db);
    expect(rows.rows).toEqual([
      { id: 'system:ADJUSTMENT:USD', kind: 'ADJUSTMENT', currency: 'USD', balance: '0' },
      { id: 'system:ADJUSTMENT:VND', kind: 'ADJUSTMENT', currency: 'VND', balance: '0' },
    ]);
  });

  it('accepts ADJUSTMENT and REVERSAL ledger kinds and rejects unknown ones', async () => {
    await insertTransaction('tx_kind_adj', 'ADJUSTMENT');
    await insertTransaction('tx_kind_rev', 'REVERSAL');
    expect(await failure(insertTransaction('tx_kind_bad', 'BOGUS'))).toContain(
      'ck_ledger_transactions_kind',
    );
  });

  it('lets a transaction be reversed only once, while unlinked rows are unrestricted', async () => {
    await insertTransaction('tx_orig', 'ORDER_PAYMENT');
    await insertTransaction('tx_rev_1', 'REVERSAL', 'tx_orig');
    expect(await failure(insertTransaction('tx_rev_2', 'REVERSAL', 'tx_orig'))).toContain(
      'ux_ledger_transactions_reverses',
    );
    // Hai dòng null không vi phạm chỉ mục unique có lọc.
    await insertTransaction('tx_plain_1', 'TOPUP');
    await insertTransaction('tx_plain_2', 'TOPUP');
    expect(await failure(insertTransaction('tx_rev_dangling', 'REVERSAL', 'tx_missing'))).toContain(
      'fk_ledger_transactions_reverses',
    );
  });

  it('creates an append-only ops_actions table with unique keys and a bounded action set', async () => {
    const insert = (id: string, key: string, action = 'FREEZE') =>
      sql`insert into ${t('ops_actions')}
        (id, action, actor, reason, target, idempotency_key, fingerprint, result, created_at)
        values (${id}, ${action}, 'ops@x', 'why', 'w:1', ${key}, 'fp', '{}', ${when()})`.execute(
        db,
      );
    await insert('act_1', 'key-1');
    expect(await failure(insert('act_2', 'key-1'))).toContain('uq_ops_actions_key');
    expect(await failure(insert('act_3', 'key-3', 'NUKE'))).toContain('ck_ops_actions_action');
    expect(
      await failure(
        sql`update ${t('ops_actions')} set reason = 'x' where id = 'act_1'`.execute(db),
      ),
    ).toContain('append-only');
    expect(await failure(sql`delete from ${t('ops_actions')}`.execute(db))).toContain(
      'append-only',
    );
  });

  describe('upgrading a tenant that already holds data', () => {
    const schema = 't_backfill';
    const bt = (name: string) => sql.id(schema, name);
    const outbox = (id: string, eventType: string, payload: object, createdAt: string) =>
      sql`insert into ${bt('outbox')}
        (id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at)
        values (${id}, ${eventType}, 'rk', ${JSON.stringify(payload)}, 'corr', 'SENT', 0, ${when()},
                ${dateTime(new Date(createdAt))})`.execute(db);

    beforeAll(async () => {
      await sql.raw(`create schema [${schema}]`).execute(db);
      const all = walletMigrations(schema);
      const upTo006 = Object.fromEntries(Object.entries(all).filter(([name]) => name < '007'));
      expect(Object.keys(upTo006)).toHaveLength(6);
      await migrate(db, upTo006, { migrationTableSchema: schema });

      // Dữ liệu có sẵn trước 007: ví có số dư, giao dịch sổ cái (bị trigger bất biến bảo vệ), thanh toán order.
      await sql`insert into ${bt('accounts')} (id, kind, customer_id, currency, balance, created_at)
        values ('w:old', 'WALLET', 'cus_1', 'VND', 70, ${when()})`.execute(db);
      for (const id of ['tx_pay_a', 'tx_pay_b', 'tx_pay_c', 'tx_pay_d']) {
        await sql`insert into ${bt('ledger_transactions')} (id, business_key, kind, created_at)
          values (${id}, ${`order:${id}`}, 'ORDER_PAYMENT', ${when()})`.execute(db);
      }
      for (const [order, tx] of [
        ['ord_a', 'tx_pay_a'],
        ['ord_b', 'tx_pay_b'],
        ['ord_gone', 'tx_pay_c'],
        ['ord_tie', 'tx_pay_d'],
      ] as const) {
        await sql`insert into ${bt('order_payments')}
          (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values (${order}, 'cus_1', ${tx}, 30, 'VND', ${when()})`.execute(db);
      }
      // ord_a có hai dòng OrderPaidV1 (lần đầu và bản phát lại): phải lấy eventId của dòng cũ nhất, bất kể thứ tự chèn
      // và id: dòng MUỘN hơn được chèn TRƯỚC và có id NHỎ hơn.
      await outbox(
        'ob_a1',
        'OrderPaidV1',
        { orderId: 'ord_a', eventId: 'evt_a_replay' },
        '2026-10-02T00:00:00Z',
      );
      await outbox(
        'ob_a2',
        'OrderPaidV1',
        { orderId: 'ord_a', eventId: 'evt_a_first' },
        '2026-10-01T00:00:00Z',
      );
      // ord_tie có hai dòng cùng created_at: id nhỏ nhất thắng (dòng id lớn được chèn trước).
      await outbox(
        'ob_t2',
        'OrderPaidV1',
        { orderId: 'ord_tie', eventId: 'evt_tie_high' },
        '2026-10-01T00:00:00Z',
      );
      await outbox(
        'ob_t1',
        'OrderPaidV1',
        { orderId: 'ord_tie', eventId: 'evt_tie_low' },
        '2026-10-01T00:00:00Z',
      );
      await outbox(
        'ob_b',
        'OrderPaidV1',
        { orderId: 'ord_b', eventId: 'evt_b' },
        '2026-10-01T00:00:00Z',
      );
      // Sự kiện khác loại không được lẫn vào.
      await outbox(
        'ob_x',
        'OrderPaymentFailedV1',
        { orderId: 'ord_gone', eventId: 'evt_x' },
        '2026-10-01T00:00:00Z',
      );

      const applied = await migrate(db, walletMigrations(schema), { migrationTableSchema: schema });
      expect(applied).toEqual(['007-ops-tools']);
    });

    it('backfills paid_event_id from the oldest OrderPaidV1 outbox row and leaves orphans null', async () => {
      const rows = await sql<{ order_id: string; paid_event_id: string | null }>`
        select order_id, paid_event_id from ${bt('order_payments')} order by order_id`.execute(db);
      expect(rows.rows).toEqual([
        { order_id: 'ord_a', paid_event_id: 'evt_a_first' },
        { order_id: 'ord_b', paid_event_id: 'evt_b' },
        { order_id: 'ord_gone', paid_event_id: null },
        { order_id: 'ord_tie', paid_event_id: 'evt_tie_low' },
      ]);
    });

    it('keeps existing accounts and ledger rows and applies the new constraints to them', async () => {
      const wallet = await sql<{ balance: string; frozen_at: Date | null }>`
        select balance, frozen_at from ${bt('accounts')} where id = 'w:old'`.execute(db);
      expect(wallet.rows).toEqual([{ balance: '70', frozen_at: null }]);
      const txs = await sql<{ n: number }>`
        select count(*) as n from ${bt('ledger_transactions')}`.execute(db);
      expect(txs.rows[0]?.n).toBe(4);
      const adj = await sql<{ n: number }>`
        select count(*) as n from ${bt('accounts')} where kind = 'ADJUSTMENT'`.execute(db);
      expect(adj.rows[0]?.n).toBe(2);

      await sql`insert into ${bt('ledger_transactions')} (id, business_key, kind, created_at, reverses_transaction_id)
        values ('tx_rev_a', 'rev:a', 'REVERSAL', ${when()}, 'tx_pay_a')`.execute(db);
      expect(
        await failure(
          sql`insert into ${bt('ledger_transactions')} (id, business_key, kind, created_at, reverses_transaction_id)
            values ('tx_rev_a2', 'rev:a2', 'REVERSAL', ${when()}, 'tx_pay_a')`.execute(db),
        ),
      ).toContain('ux_ledger_transactions_reverses');
      // Trigger bất biến của sổ cái vẫn còn hiệu lực sau khi ALTER.
      expect(
        await failure(
          sql`update ${bt('ledger_transactions')} set kind = 'TOPUP' where id = 'tx_pay_a'`.execute(
            db,
          ),
        ),
      ).toContain('ledger is immutable');
    });
  });
});
