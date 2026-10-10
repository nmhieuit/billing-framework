import { createDatabase, dateTime, migrate } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { walletMigrations } from './migrations/index.js';
import { provisionTenants } from './provisioning.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;
const when = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));

beforeAll(async () => {
  testDb = await createTestDatabase('ordersmig');
  db = createDatabase<unknown>(testDb.config);
  await provisionTenants(db, [TenantId.parse('acme')]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const t = (name: string) => sql.id('t_acme', name);
const sqlNumber = async (work: Promise<unknown>): Promise<number | undefined> =>
  work.then(
    () => undefined,
    (error: { number?: number }) => error.number,
  );

describe('003-orders', () => {
  it('accepts ORDER_PAYMENT ledger transactions and still rejects unknown kinds', async () => {
    await sql`insert into ${t('ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_o1', 'order:1', 'ORDER_PAYMENT', ${when()})`.execute(db);
    expect(
      await sqlNumber(
        sql`insert into ${t('ledger_transactions')} (id, business_key, kind, created_at)
          values ('tx_bad', 'x:1', 'BOGUS', ${when()})`.execute(db),
      ),
    ).toBe(547);
  });

  it('keeps one paid row per order, tied to an existing ledger transaction', async () => {
    await sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
      values ('o1', 'c1', 'tx_o1', 50000, 'VND', ${when()})`.execute(db);
    expect(
      await sqlNumber(
        sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values ('o1', 'c1', 'tx_o1', 50000, 'VND', ${when()})`.execute(db),
      ),
    ).toBe(2627);
    expect(
      await sqlNumber(
        sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values ('o2', 'c1', 'tx_missing', 50000, 'VND', ${when()})`.execute(db),
      ),
    ).toBe(547);
    expect(
      await sqlNumber(
        sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values ('o3', 'c1', 'tx_o1', 0, 'VND', ${when()})`.execute(db),
      ),
    ).toBe(547);
  });

  it('constrains the outbox status and indexes it for the relay', async () => {
    expect(
      await sqlNumber(
        sql`insert into ${t('outbox')} (id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at)
          values ('e1', 'OrderPaidV1', 'order-paid.v1', '{}', 'c', 'WEIRD', 0, ${when()}, ${when()})`.execute(
          db,
        ),
      ),
    ).toBe(547);
    const columns = await sql<{ name: string }>`
      select c.name from sys.indexes i
      join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
      join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
      where i.name = 'ix_outbox_due' and i.object_id = object_id(N'[t_acme].[outbox]')
      order by ic.key_ordinal`.execute(db);
    expect(columns.rows.map((r) => r.name)).toEqual(['status', 'next_attempt_at', 'id']);
  });

  it('upgrades a tenant that already holds ledger data without losing it', async () => {
    const schema = 't_legacy';
    await sql.raw(`create schema [${schema}]`).execute(db);
    const all = walletMigrations(schema);
    await migrate(
      db,
      { '001-ledger': all['001-ledger']!, '002-topups': all['002-topups']! },
      { migrationTableSchema: schema },
    );
    await sql`insert into ${sql.id(schema, 'ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_old', 'topup:old', 'TOPUP', ${when()})`.execute(db);

    expect(await provisionTenants(db, [TenantId.parse('legacy')])).toEqual({
      legacy: ['003-orders', '004-reconciliation'],
    });

    const rows = await sql<{
      id: string;
    }>`select id from ${sql.id(schema, 'ledger_transactions')}`.execute(db);
    expect(rows.rows.map((r) => r.id)).toEqual(['tx_old']);
    await sql`insert into ${sql.id(schema, 'ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_new', 'order:legacy', 'ORDER_PAYMENT', ${when()})`.execute(db);
  });
});
