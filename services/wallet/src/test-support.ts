import { createDatabase } from '@billing/database';
import type { Currency } from '@billing/money';
import { FakeClock, createTestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import { ApplyPaymentResult } from './application/apply-payment-result.js';
import { CreateWallet } from './application/create-wallet.js';
import type { IdGenerator, Logger } from './application/ports.js';
import { RequestTopup } from './application/request-topup.js';
import { CustomerId } from './domain/customer-id.js';
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
  #events = 0;

  topupId(): string {
    return `tp_${String(++this.#topups).padStart(6, '0')}`;
  }

  transactionId(): string {
    return `tx_${String(++this.#transactions).padStart(6, '0')}`;
  }

  eventId(): string {
    return `00000000-0000-4000-8000-${String(++this.#events).padStart(12, '0')}`;
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

export interface SeededTopup {
  tenant: TenantId;
  customer: string;
  topupId: string;
  chargeId: string;
  amount: number;
  currency: Currency;
}

let seedCounter = 0;

/** Dựng nhanh một ví và một lần nạp ở trạng thái mong muốn, bằng chính các use case và aggregate thật. */
export async function seedTopup(
  h: Harness,
  options: {
    tenant?: TenantId;
    customer?: string;
    amount?: number;
    currency?: Currency;
    state?: 'REQUESTED' | 'PENDING' | 'FAILED_UNAVAILABLE' | 'FAILED_REJECTED';
  } = {},
): Promise<SeededTopup> {
  const tenant = options.tenant ?? h.acme;
  const currency = options.currency ?? 'VND';
  const amount = options.amount ?? 150000;
  const customer = options.customer ?? `seed${++seedCounter}`;
  const customerId = CustomerId.parse(customer);
  await new CreateWallet({ uow: h.uow, clock: h.clock }).execute({ tenant, customerId, currency });
  const { body } = await new RequestTopup({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    submitter: { submitSoon: () => undefined },
  }).execute({ tenant, customerId, idempotencyKey: `seed-key-${++seedCounter}`, amount });

  const chargeId = `ch_${body.topupId}`;
  const state = options.state ?? 'PENDING';
  if (state !== 'REQUESTED') {
    await h.uow.run(tenant, async ({ topups }) => {
      const topup = await topups.lockById(body.topupId);
      if (!topup) throw new Error('seeded topup disappeared');
      const now = h.clock.now();
      const next =
        state === 'PENDING'
          ? topup.recordSubmitted(chargeId)
          : state === 'FAILED_REJECTED'
            ? topup.recordRejected(now)
            : topup.recordUnavailable(now, []);
      await topups.save(next);
    });
  }
  return { tenant, customer, topupId: body.topupId, chargeId, amount, currency };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Nạp tiền thật vào ví (tạo ví nếu chưa có) bằng đúng luồng nạp: lần nạp PENDING rồi webhook thành công. */
export async function fundWallet(
  h: Harness,
  options: { tenant?: TenantId; customer: string; amount: number; currency?: Currency },
): Promise<void> {
  const seeded = await seedTopup(h, { ...options, state: 'PENDING' });
  const outcome = await new ApplyPaymentResult({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
  }).execute({
    tenant: seeded.tenant,
    eventId: `evt_fund_${seeded.topupId}`,
    type: 'charge.succeeded',
    chargeId: seeded.chargeId,
    reference: seeded.topupId,
    amount: seeded.amount,
    currency: seeded.currency,
  });
  if (outcome !== 'APPLIED') throw new Error(`could not fund wallet: ${outcome}`);
}
