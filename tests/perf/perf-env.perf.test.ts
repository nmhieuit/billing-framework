import { randomUUID } from 'node:crypto';
import { createDatabase } from '@billing/database';
import { sql } from 'kysely';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { assertConcurrencyFitsPool, createPerfEnv, type PerfEnv } from './support/perf-env.js';
import { seedCustomers, seedPendingTopups } from './support/seed.js';
import { checkLedger, readLedgerCounts } from './support/validity.js';

const envs: PerfEnv[] = [];
afterEach(async () => {
  while (envs.length > 0) await envs.pop()?.stop();
});

async function newEnv(tenants: number): Promise<PerfEnv> {
  const env = await createPerfEnv({ tenants });
  envs.push(env);
  return env;
}

/** Kết nối vào master (độc lập với env) để liệt kê database còn sót lại. */
async function perfDatabases(): Promise<string[]> {
  const server = inject('sqlServer');
  const master = createDatabase<unknown>({
    host: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    database: 'master',
    poolMax: 1,
  });
  try {
    const rows = await sql<{
      name: string;
    }>`select name from sys.databases where name like 'perf_env[_]%'`.execute(master);
    return rows.rows.map((r) => r.name).sort();
  } finally {
    await master.destroy();
  }
}

const schemaOf = (tenant: { value: string }): string => `t_${tenant.value}`;

describe('môi trường đo mức use case', () => {
  it('stop() xóa database, idempotent, và dọn được cả khi dựng dở', async () => {
    const before = await perfDatabases();

    const env = await createPerfEnv({ tenants: 2 });
    expect(env.tenants.map((t) => t.value)).toEqual(['perf1', 'perf2']);
    expect(await perfDatabases()).toContain(env.databaseName);

    await env.stop();
    await env.stop(); // gọi lần hai không được ném lỗi
    expect(await perfDatabases()).toEqual(before);

    // Dựng dở: database đã tạo xong nhưng tên tenant sai → createPerfEnv ném lỗi gốc và KHÔNG để lại database.
    await expect(createPerfEnv({ tenants: 1, tenantNames: ['Tên-Sai'] })).rejects.toThrow(
      /tenant id/,
    );
    expect(await perfDatabases()).toEqual(before);
  });

  it('poolMax: mặc định >= 64, guard concurrency chặn mức vượt pool', async () => {
    const env = await newEnv(1);
    expect(env.poolMax).toBeGreaterThanOrEqual(64);
    expect(() => assertConcurrencyFitsPool(env, 64)).not.toThrow();
    expect(() => assertConcurrencyFitsPool(env, 65)).toThrow(/poolMax/);

    const small = await createPerfEnv({ tenants: 1, poolMax: 8 });
    envs.push(small);
    expect(small.poolMax).toBe(8);
    expect(() => assertConcurrencyFitsPool(small, 8)).not.toThrow();
    expect(() => assertConcurrencyFitsPool(small, 16)).toThrow(/poolMax/);
  });

  it('seedCustomers: ví đúng số dư, trải đều tenant, sổ cái hợp lệ', async () => {
    const env = await newEnv(2);
    const customers = await seedCustomers(env, { count: 50, balance: 1_000_000, concurrency: 8 });
    expect(customers).toHaveLength(50);
    expect(new Set(customers.map((c) => `${c.tenant.value}/${c.customerId}`)).size).toBe(50);

    for (const tenant of env.tenants) {
      const mine = customers.filter((c) => c.tenant.equals(tenant));
      expect(Math.abs(mine.length - 25)).toBeLessThanOrEqual(1);
      const wallets = await sql<{ customer_id: string; balance: string; currency: string }>`
        select customer_id, balance, currency from ${sql.id(schemaOf(tenant), 'accounts')}
        where kind = 'WALLET'`.execute(env.admin);
      expect(wallets.rows).toHaveLength(mine.length);
      for (const row of wallets.rows) {
        expect(Number(row.balance)).toBe(1_000_000);
        expect(row.currency).toBe('VND');
      }
    }
    expect(await checkLedger(env)).toEqual([]);
  });

  it('seedPendingTopups: topup PENDING có charge_id; ApplyPaymentResult thật áp được', async () => {
    const env = await newEnv(2);
    const customers = await seedCustomers(env, { count: 4, balance: 1_000, concurrency: 4 });
    const topups = await seedPendingTopups(env, { count: 4, customers, amount: 50_000 });
    expect(topups).toHaveLength(4);
    expect(new Set(topups.map((t) => t.topupId)).size).toBe(4);

    for (const t of topups) {
      const row = await sql<{ status: string; charge_id: string | null; amount: string }>`
        select status, charge_id, amount from ${sql.id(schemaOf(t.tenant), 'topups')}
        where id = ${t.topupId}`.execute(env.admin);
      expect(row.rows[0]).toMatchObject({ status: 'PENDING', charge_id: t.chargeId });
      expect(Number(row.rows[0]?.amount)).toBe(50_000);
    }

    const before = await readLedgerCounts(env);
    const t = topups[0]!;
    const outcome = await env.applyPayment.execute({
      tenant: t.tenant,
      eventId: randomUUID(),
      type: 'charge.succeeded',
      chargeId: t.chargeId,
      reference: t.topupId,
      amount: t.amount,
      currency: t.currency,
    });
    expect(outcome).toBe('APPLIED');
    const after = await readLedgerCounts(env);
    expect(after.topupTransactions - before.topupTransactions).toBe(1);
    expect(after.orderPayments).toBe(before.orderPayments);
    expect(await checkLedger(env)).toEqual([]);
  });

  it('counts phản ánh đúng các lần gọi use case thật (trả order, đảo)', async () => {
    const env = await newEnv(2);
    const seeded = await seedCustomers(env, { count: 2, balance: 1_000_000, concurrency: 2 });
    const c = seeded[0]!;
    const other = seeded[1]!;
    expect(c.tenant.equals(other.tenant)).toBe(false);
    const start = await readLedgerCounts(env);

    // Tenant THỨ HAI: một lần trả order và một lần áp nạp tiền; counts phải cộng qua mọi tenant.
    const paidOther = await env.payOrder.execute({
      tenant: other.tenant,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      orderId: `o-${randomUUID()}`,
      customerId: other.customerId,
      amount: 10_000,
      currency: 'VND',
    });
    expect(paidOther.kind).toBe('PAID');
    const [topupOther] = await seedPendingTopups(env, {
      count: 1,
      customers: [other],
      amount: 20_000,
    });
    expect(
      await env.applyPayment.execute({
        tenant: other.tenant,
        eventId: randomUUID(),
        type: 'charge.succeeded',
        chargeId: topupOther!.chargeId,
        reference: topupOther!.topupId,
        amount: topupOther!.amount,
        currency: topupOther!.currency,
      }),
    ).toBe('APPLIED');
    const zero = await readLedgerCounts(env);
    expect(zero.orderPayments - start.orderPayments).toBe(1);
    expect(zero.orderPaymentTransactions - start.orderPaymentTransactions).toBe(1);
    expect(zero.topupTransactions - start.topupTransactions).toBe(1);

    const paid = await env.payOrder.execute({
      tenant: c.tenant,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      orderId: `o-${randomUUID()}`,
      customerId: c.customerId,
      amount: 70_000,
      currency: 'VND',
    });
    expect(paid.kind).toBe('PAID');
    const afterPay = await readLedgerCounts(env);
    expect(afterPay.orderPayments - zero.orderPayments).toBe(1);
    expect(afterPay.orderPaymentTransactions - zero.orderPaymentTransactions).toBe(1);
    expect(afterPay.reversalTransactions).toBe(zero.reversalTransactions);

    // Đơn bị từ chối (hết tiền) không được làm counts tăng.
    const rejected = await env.payOrder.execute({
      tenant: c.tenant,
      eventId: randomUUID(),
      correlationId: randomUUID(),
      orderId: `o-${randomUUID()}`,
      customerId: c.customerId,
      amount: 5_000_000,
      currency: 'VND',
    });
    expect(rejected).toMatchObject({ kind: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    expect(await readLedgerCounts(env)).toEqual(afterPay);

    if (paid.kind !== 'PAID') throw new Error('unreachable');
    await env.reverse.execute({
      tenant: c.tenant,
      transactionId: paid.walletTransactionId,
      actor: 'perf',
      reason: 'perf-env test',
      idempotencyKey: randomUUID(),
    });
    const afterReverse = await readLedgerCounts(env);
    expect(afterReverse.reversalTransactions - afterPay.reversalTransactions).toBe(1);
    expect(afterReverse.orderPayments).toBe(afterPay.orderPayments);
    expect(await checkLedger(env)).toEqual([]);
  });

  it('oracle: checkLedger báo vi phạm khi trạng thái bị làm hỏng, và ném lỗi khi truy vấn lỗi', async () => {
    const env = await newEnv(1);
    const [c] = await seedCustomers(env, { count: 3, balance: 10_000, concurrency: 3 });
    const tenant = c!.tenant;
    const schema = schemaOf(tenant);
    expect(await checkLedger(env)).toEqual([]);

    // (1) Số dư ví lệch một đơn vị: tổng số dư ≠ 0 VÀ số dư ví ≠ tổng dòng sổ cái, nêu đúng tài khoản.
    const walletId = `wallet:${c!.customerId}`;
    await sql`update ${sql.id(schema, 'accounts')} set balance = balance + 1
      where id = ${walletId}`.execute(env.admin);
    const drifted = await checkLedger(env);
    expect(drifted.some((v) => v.includes(walletId) && /entries/.test(v))).toBe(true);
    expect(drifted.some((v) => /sum of all balances/.test(v) && v.includes(tenant.value))).toBe(
      true,
    );
    await sql`update ${sql.id(schema, 'accounts')} set balance = balance - 1
      where id = ${walletId}`.execute(env.admin);
    expect(await checkLedger(env)).toEqual([]);

    // (3) Truy vấn lỗi (bảng biến mất) phải ném lỗi, không được coi là "hợp lệ".
    await sql`exec sp_rename ${`${schema}.ledger_entries`}, 'ledger_entries_gone'`.execute(
      env.admin,
    );
    await expect(checkLedger(env)).rejects.toThrow();
    await expect(readLedgerCounts(env)).resolves.toBeDefined(); // counts không đụng ledger_entries
    await sql`exec sp_rename ${`${schema}.ledger_entries_gone`}, 'ledger_entries'`.execute(
      env.admin,
    );
    expect(await checkLedger(env)).toEqual([]);
    // (2) Thêm một dòng lẻ vào giao dịch có sẵn (sổ cái bất biến nên không sửa/xóa được; chỉ chèn được): giao dịch không cân
    // và số dư tài khoản lệch khỏi tổng dòng. Trạng thái này không khôi phục được nên đặt cuối cùng.
    const entry = await sql<{ transaction_id: string; account_id: string }>`
      select top 1 transaction_id, account_id from ${sql.id(schema, 'ledger_entries')}`.execute(
      env.admin,
    );
    const target = entry.rows[0]!;
    await sql`insert into ${sql.id(schema, 'ledger_entries')} (transaction_id, account_id, amount, created_at)
      values (${target.transaction_id}, ${target.account_id}, 7, sysutcdatetime())`.execute(
      env.admin,
    );
    const unbalanced = await checkLedger(env);
    expect(unbalanced.some((v) => /transaction/.test(v) && v.includes(target.transaction_id))).toBe(
      true,
    );
    expect(unbalanced.some((v) => v.includes(`account ${target.account_id}`))).toBe(true);
  });
});
