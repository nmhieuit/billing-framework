import { createDatabase, dateTime } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { assertMigrated, provisionTenants } from './provisioning.js';
import { schemaName } from './schema-name.js';

const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');

let testDb: TestDatabase;
let db: Kysely<unknown>;

beforeAll(async () => {
  testDb = await createTestDatabase('provision');
  db = createDatabase<unknown>(testDb.config);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const t = (tenant: TenantId, table: string) => sql.id(schemaName(tenant), table);
const now = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));

describe('provisionTenants', () => {
  it('refuses to start against tenants that were never provisioned', async () => {
    await expect(assertMigrated(db, [acme])).rejects.toThrow(/acme/);
  });

  it('creates both tenant schemas, applies every migration, and is idempotent', async () => {
    expect(await provisionTenants(db, [acme, beta])).toEqual({
      acme: ['001-ledger', '002-topups', '003-orders', '004-reconciliation'],
      beta: ['001-ledger', '002-topups', '003-orders', '004-reconciliation'],
    });
    expect(await provisionTenants(db, [acme, beta])).toEqual({ acme: [], beta: [] });
    await expect(assertMigrated(db, [acme, beta])).resolves.toBeUndefined();
  });

  it('names the tenant and the missing migrations when one is behind', async () => {
    await provisionTenants(db, [TenantId.parse('gamma')]);
    await sql`delete from ${sql.id('t_gamma', 'kysely_migration')} where name = '002-topups'`.execute(
      db,
    );
    await expect(assertMigrated(db, [TenantId.parse('gamma')])).rejects.toThrow(
      /gamma.*002-topups/,
    );
  });

  it('puts the same tables in each tenant schema, with the four system accounts', async () => {
    for (const tenant of [acme, beta]) {
      const tables = await sql<{ name: string }>`
        select t.name from sys.tables t join sys.schemas s on s.schema_id = t.schema_id
        where s.name = ${schemaName(tenant)}`.execute(db);
      expect(tables.rows.map((r) => r.name).sort()).toEqual([
        'accounts',
        'idempotency_keys',
        'kysely_migration',
        'kysely_migration_lock',
        'ledger_entries',
        'ledger_transactions',
        'order_payments',
        'outbox',
        'processed_messages',
        'reconciliation_items',
        'reconciliation_runs',
        'topups',
      ]);
      const accounts = await sql<{ id: string; kind: string; balance: string }>`
        select id, kind, balance from ${t(tenant, 'accounts')} order by id`.execute(db);
      expect(accounts.rows).toEqual([
        { id: 'system:GATEWAY:USD', kind: 'GATEWAY', balance: '0' },
        { id: 'system:GATEWAY:VND', kind: 'GATEWAY', balance: '0' },
        { id: 'system:MERCHANT:USD', kind: 'MERCHANT', balance: '0' },
        { id: 'system:MERCHANT:VND', kind: 'MERCHANT', balance: '0' },
      ]);
    }
  });

  it('keeps tenants isolated even with identical ids', async () => {
    for (const [tenant, balance] of [
      [acme, 100],
      [beta, 5],
    ] as const) {
      await sql`insert into ${t(tenant, 'accounts')} (id, kind, customer_id, currency, balance, created_at)
        values (${'wallet:c1'}, 'WALLET', ${'c1'}, 'VND', ${balance}, ${now()})`.execute(db);
    }
    const read = async (tenant: TenantId) =>
      (
        await sql<{
          balance: string;
        }>`select balance from ${t(tenant, 'accounts')} where id = ${'wallet:c1'}`.execute(db)
      ).rows;
    expect(await read(acme)).toEqual([{ balance: '100' }]);
    expect(await read(beta)).toEqual([{ balance: '5' }]);
  });
});

describe('ledger and account constraints (tenant acme)', () => {
  const insertAccount = (id: string, kind: string, balance: number, currency = 'VND') =>
    sql`insert into ${t(acme, 'accounts')} (id, kind, customer_id, currency, balance, created_at)
      values (${id}, ${kind}, null, ${currency}, ${balance}, ${now()})`.execute(db);
  const insertTransaction = (id: string, businessKey: string) =>
    sql`insert into ${t(acme, 'ledger_transactions')} (id, business_key, kind, created_at)
      values (${id}, ${businessKey}, 'TOPUP', ${now()})`.execute(db);
  const insertEntry = (transactionId: string, accountId: string, amount: number) =>
    sql`insert into ${t(acme, 'ledger_entries')} (transaction_id, account_id, amount, created_at)
      values (${transactionId}, ${accountId}, ${amount}, ${now()})`.execute(db);

  it.each([
    ['a negative wallet', 'WALLET', -1],
    ['a positive gateway account', 'GATEWAY', 1],
    ['a negative merchant account', 'MERCHANT', -1],
  ])('rejects %s with a CHECK violation', async (_name, kind, balance) => {
    await expect(insertAccount(`bad-${kind}`, kind, balance)).rejects.toMatchObject({
      number: 547,
    });
  });

  it('rejects an unknown kind and an unsupported currency', async () => {
    await expect(insertAccount('bad-kind', 'OTHER', 0)).rejects.toMatchObject({ number: 547 });
    await expect(insertAccount('bad-cur', 'WALLET', 0, 'EUR')).rejects.toMatchObject({
      number: 547,
    });
  });

  it('enforces a unique business key (duplicate ledger postings are impossible)', async () => {
    await insertTransaction('tx_a', 'topup:one');
    await expect(insertTransaction('tx_b', 'topup:one')).rejects.toMatchObject({ number: 2627 });
  });

  it('rejects a zero entry, but accepts positive and negative ones', async () => {
    await insertTransaction('tx_c', 'topup:two');
    await expect(insertEntry('tx_c', 'system:GATEWAY:VND', 0)).rejects.toMatchObject({
      number: 547,
    });
    await insertEntry('tx_c', 'system:GATEWAY:VND', -50);
    await insertEntry('tx_c', 'system:MERCHANT:VND', 50);
  });

  it('makes the ledger append-only: UPDATE and DELETE fail with 50001 on both ledger tables', async () => {
    await insertTransaction('tx_d', 'topup:three');
    await insertEntry('tx_d', 'system:GATEWAY:VND', -1);
    await expect(
      sql`update ${t(acme, 'ledger_entries')} set amount = 9`.execute(db),
    ).rejects.toMatchObject({ number: 50001 });
    await expect(sql`delete from ${t(acme, 'ledger_entries')}`.execute(db)).rejects.toMatchObject({
      number: 50001,
    });
    await expect(
      sql`update ${t(acme, 'ledger_transactions')} set kind = 'TOPUP'`.execute(db),
    ).rejects.toMatchObject({ number: 50001 });
    await expect(
      sql`delete from ${t(acme, 'ledger_transactions')}`.execute(db),
    ).rejects.toMatchObject({
      number: 50001,
    });
  });

  it('accepts only known topup statuses and positive amounts', async () => {
    await insertAccount('wallet:c9', 'WALLET', 0);
    const topup = (status: string, amount: number) =>
      sql`insert into ${t(acme, 'topups')}
        (id, customer_id, account_id, amount, currency, status, attempts, next_attempt_at, created_at)
        values (${`tp_${status}_${amount}`}, 'c9', 'wallet:c9', ${amount}, 'VND', ${status}, 0, ${now()}, ${now()})`.execute(
        db,
      );
    await topup('REQUESTED', 100);
    await expect(topup('WEIRD', 100)).rejects.toMatchObject({ number: 547 });
    await expect(topup('REQUESTED', 0)).rejects.toMatchObject({ number: 547 });
  });

  it('treats idempotency keys as case-sensitive and scoped per customer', async () => {
    await insertAccount('wallet:c10', 'WALLET', 0);
    await sql`insert into ${t(acme, 'topups')}
      (id, customer_id, account_id, amount, currency, status, attempts, next_attempt_at, created_at)
      values ('tp_idem', 'c10', 'wallet:c10', 1, 'VND', 'REQUESTED', 0, ${now()}, ${now()})`.execute(
      db,
    );
    const key = (customer: string, value: string) =>
      sql`insert into ${t(acme, 'idempotency_keys')}
        (customer_id, idempotency_key, request_hash, response_status, response_body, topup_id, created_at)
        values (${customer}, ${value}, 'h', 202, '{}', 'tp_idem', ${now()})`.execute(db);
    await key('c10', 'ABC');
    await key('c10', 'abc');
    await key('c11', 'ABC');
    await expect(key('c10', 'ABC')).rejects.toMatchObject({ number: 2627 });
  });

  it('rejects a repeated inbox message for the same consumer only', async () => {
    const inbox = (consumer: string, id: string) =>
      sql`insert into ${t(acme, 'processed_messages')} (consumer, message_id, processed_at)
        values (${consumer}, ${id}, ${now()})`.execute(db);
    await inbox('payment-webhook', 'evt_1');
    await inbox('other', 'evt_1');
    await expect(inbox('payment-webhook', 'evt_1')).rejects.toMatchObject({ number: 2627 });
  });
});
