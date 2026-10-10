import { createDatabase } from '@billing/database';
import { FakeClock, createTestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { IdGenerator } from './application/ports.js';
import { TenantId } from './domain/tenant-id.js';
import { ConfigTenantRegistry } from './infrastructure/tenant-registry.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import { schemaName } from './infrastructure/kysely/schema-name.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';

/** Mã định danh tất định để test so sánh được: tp_000001, tx_000001, ... */
export class SequentialIds implements IdGenerator {
  #topups = 0;
  #transactions = 0;

  topupId(): string {
    return `tp_${String(++this.#topups).padStart(6, '0')}`;
  }

  transactionId(): string {
    return `tx_${String(++this.#transactions).padStart(6, '0')}`;
  }
}

export interface Harness {
  db: Kysely<WalletDatabase>;
  clock: FakeClock;
  ids: SequentialIds;
  uow: KyselyTenantUnitOfWork;
  registry: ConfigTenantRegistry;
  acme: TenantId;
  beta: TenantId;
  close(): Promise<void>;
}

/** Dựng một database riêng đã cấp phát hai tenant `acme` và `beta`. Chỉ dùng trong integration test (chạy bằng `sa`, có db_owner). */
export async function createHarness(start = '2026-10-10T10:00:00.000Z'): Promise<Harness> {
  const testDb = await createTestDatabase('wallet');
  const db = createDatabase<WalletDatabase>(testDb.config);
  const acme = TenantId.parse('acme');
  const beta = TenantId.parse('beta');
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
  return {
    db,
    clock: new FakeClock(start),
    ids: new SequentialIds(),
    uow: new KyselyTenantUnitOfWork(db),
    registry: new ConfigTenantRegistry([acme, beta]),
    acme,
    beta,
    async close() {
      await db.destroy();
      await testDb.drop();
    },
  };
}

/**
 * Bất biến của sổ cái một tenant: tổng số dư mọi tài khoản = 0; số dư mỗi tài khoản = tổng các dòng của nó;
 * tổng các dòng của mỗi giao dịch = 0.
 */
export async function expectLedgerInvariants(h: Harness, tenant: TenantId): Promise<void> {
  const schema = schemaName(tenant);
  const total = await sql<{ total: string | null }>`
    select sum(balance) as total from ${sql.id(schema, 'accounts')}`.execute(h.db);
  expect(Number(total.rows[0]?.total ?? 0), 'sum of all balances').toBe(0);

  const drift = await sql<{ id: string }>`
    select a.id from ${sql.id(schema, 'accounts')} a
    left join (select account_id, sum(amount) as total from ${sql.id(schema, 'ledger_entries')} group by account_id) e
      on e.account_id = a.id
    where a.balance <> coalesce(e.total, 0)`.execute(h.db);
  expect(
    drift.rows.map((r) => r.id),
    'accounts whose balance differs from their entries',
  ).toEqual([]);

  const unbalanced = await sql<{ transaction_id: string }>`
    select transaction_id from ${sql.id(schema, 'ledger_entries')}
    group by transaction_id having sum(amount) <> 0`.execute(h.db);
  expect(
    unbalanced.rows.map((r) => r.transaction_id),
    'unbalanced transactions',
  ).toEqual([]);
}
