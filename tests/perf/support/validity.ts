import { sql } from 'kysely';
import type { PerfEnv } from './perf-env.js';

export interface LedgerCounts {
  orderPayments: number;
  orderPaymentTransactions: number;
  topupTransactions: number;
  reversalTransactions: number;
}

/** Đọc một số đếm; truy vấn lỗi thì ném (không bao giờ coi lỗi là 0). */
const num = (value: string | number | null | undefined): number => Number(value ?? 0);

/**
 * Cộng qua mọi tenant: số dòng `order_payments` và số giao dịch sổ cái theo loại. Dùng trước/sau lượt đo (lúc không có tải)
 * để đối chiếu hiệu số với số thao tác thành công do driver báo.
 */
export async function readLedgerCounts(env: PerfEnv): Promise<LedgerCounts> {
  const totals: LedgerCounts = {
    orderPayments: 0,
    orderPaymentTransactions: 0,
    topupTransactions: 0,
    reversalTransactions: 0,
  };
  for (const tenant of env.tenants) {
    const schema = `t_${tenant.value}`;
    const payments = await sql<{ n: string | number }>`
      select count(*) as n from ${sql.id(schema, 'order_payments')}`.execute(env.admin);
    const kinds = await sql<{ kind: string; n: string | number }>`
      select kind, count(*) as n from ${sql.id(schema, 'ledger_transactions')}
      group by kind`.execute(env.admin);
    totals.orderPayments += num(payments.rows[0]?.n);
    for (const row of kinds.rows) {
      if (row.kind === 'ORDER_PAYMENT') totals.orderPaymentTransactions += num(row.n);
      else if (row.kind === 'TOPUP') totals.topupTransactions += num(row.n);
      else if (row.kind === 'REVERSAL') totals.reversalTransactions += num(row.n);
    }
  }
  return totals;
}

/**
 * Bất biến sổ cái của từng tenant; trả danh sách vi phạm (rỗng = hợp lệ). Truy vấn lỗi thì ném lỗi.
 * SQL sao chép từ `expectLedgerInvariants` trong services/wallet/src/test-support.ts: tổng số dư mọi tài khoản = 0;
 * số dư mỗi tài khoản = tổng các dòng sổ cái của nó; tổng các dòng của mỗi giao dịch = 0.
 * Chỉ có nghĩa khi không còn giao dịch đang bay (gọi lúc đã dừng tải).
 */
export async function checkLedger(env: PerfEnv): Promise<string[]> {
  const violations: string[] = [];
  for (const tenant of env.tenants) {
    const schema = `t_${tenant.value}`;

    const total = await sql<{ total: string | number | null }>`
      select sum(balance) as total from ${sql.id(schema, 'accounts')}`.execute(env.admin);
    const sum = num(total.rows[0]?.total);
    if (sum !== 0) {
      violations.push(`tenant ${tenant.value}: sum of all balances is ${sum}, expected 0`);
    }

    const drift = await sql<{ id: string; balance: string | number; entries: string | number }>`
      select a.id, a.balance, coalesce(e.total, 0) as entries
      from ${sql.id(schema, 'accounts')} a
      left join (select account_id, sum(amount) as total from ${sql.id(schema, 'ledger_entries')} group by account_id) e
        on e.account_id = a.id
      where a.balance <> coalesce(e.total, 0)`.execute(env.admin);
    for (const row of drift.rows) {
      violations.push(
        `tenant ${tenant.value}: account ${row.id} balance ${num(row.balance)} differs from its ledger entries ${num(row.entries)}`,
      );
    }

    const unbalanced = await sql<{ transaction_id: string; total: string | number }>`
      select transaction_id, sum(amount) as total from ${sql.id(schema, 'ledger_entries')}
      group by transaction_id having sum(amount) <> 0`.execute(env.admin);
    for (const row of unbalanced.rows) {
      violations.push(
        `tenant ${tenant.value}: transaction ${row.transaction_id} entries sum to ${num(row.total)}, expected 0`,
      );
    }
  }
  return violations;
}
