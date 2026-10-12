import { sql, type Kysely, type RawBuilder } from 'kysely';
import { adminQuery, type System } from './system-harness.js';

/**
 * Oracle bất biến của hệ chaos (spec §3). Chạy SAU heal() trên mọi tenant của hệ, chỉ đọc, bằng kết nối quản trị
 * KHÔNG bị plan can thiệp (walletAdmin / paymentAdmin). Đã cài: INV-1..INV-4; INV-5..INV-8 do task sau bổ sung.
 *
 * Nguyên tắc:
 *  - Mọi lỗi truy vấn đều NÉM ra (adminQuery chỉ thử lại đúng một lần, cho trường hợp session của kết nối quản trị
 *    vừa bị killSessions giết); không có nhánh nào coi lỗi là "đạt".
 *  - Hệ không có tenant nào cũng NÉM (một oracle chạy trên hệ rỗng sẽ "đạt" một cách rỗng tuếch).
 *  - Giả định retention tắt (mặc định của harness): outbox/order_payments/topups không bị dọn nên có thể đối chiếu toàn bộ.
 *  - Orders giả (system.orders) KHÔNG tự kết nối lại: lỗi broker phải được giới hạn bằng dropWalletBrokerConnections()
 *    (chỉ đóng kết nối của wallet), không được đóng kết nối của Orders giả, nếu không oracle sẽ báo thiếu sự kiện oan.
 *
 * Mã vi phạm (`Violation.code`, ổn định, dùng để phân loại bằng máy thay vì đọc chuỗi):
 *  INV-1  TOTAL_NONZERO (tổng số dư theo đồng tiền ≠ 0) | BALANCE_DRIFT (số dư ≠ tổng dòng) | TX_UNBALANCED | TX_EMPTY
 *  INV-2  ORPHAN_ORDER_TX (ORDER_PAYMENT không có order_payments) | ORDER_PAYMENT_MISPLACED (trỏ sai giao dịch)
 *         | ORDER_PAYMENT_AMOUNT_MISMATCH | RECEIVED_PAID_MISMATCH (OrderPaidV1 đã nhận khác sổ cái)
 *  INV-3  TOPUP_TX_MISSING (topup SUCCEEDED thiếu giao dịch TOPUP) | TOPUP_TX_AMOUNT_MISMATCH
 *         | TX_WITHOUT_SUCCEEDED_TOPUP (giao dịch TOPUP không có topup SUCCEEDED)
 *         | TOPUP_CHARGE_NOT_SUCCEEDED (topup SUCCEEDED nhưng charge không SUCCEEDED/khớp)
 *         | CHARGE_UNATTRIBUTED (charge SUCCEEDED không gán được tenant) | CHARGE_WITHOUT_TOPUP (không có topup nào)
 *         | CHARGE_TOPUP_NOT_SUCCEEDED (charge SUCCEEDED, topup chưa SUCCEEDED: detail.topupStatus/failureCode)
 *         | CHARGE_TOPUP_MISMATCH (topup SUCCEEDED nhưng charge_id/số tiền/đồng tiền lệch)
 *         | SUM_MISMATCH (tổng TOPUP sổ cái ≠ tổng charge SUCCEEDED theo tenant+đồng tiền)
 *         | DUPLICATE_CHARGE_ID (một charge_id cho nhiều topup) | DUPLICATE_CHARGE_REF (nhiều charge cho một reference)
 *         | CHARGE_MULTIPLE_KEYS | KEY_CHARGE_MISMATCH
 *  INV-4  OUTBOX_NOT_SENT | SENT_NOT_RECEIVED | PAID_NOT_RECEIVED | OUTBOX_PAID_UNKNOWN_ORDER | RECEIVED_PAID_UNKNOWN_ORDER
 */

export type InvariantId =
  'INV-1' | 'INV-2' | 'INV-3' | 'INV-4' | 'INV-5' | 'INV-6' | 'INV-7' | 'INV-8';

export interface Violation {
  invariant: InvariantId;
  /** Mã ổn định của loại vi phạm (xem bảng trong chú thích đầu tệp). */
  code: string;
  message: string;
  /** Id có cấu trúc: tenant, chargeId, topupId, orderId, topupStatus, failureCode, chargeStatus, amount, currency… */
  detail?: Record<string, unknown>;
}

export class InvariantViolationError extends Error {
  readonly violations: readonly Violation[];

  constructor(violations: readonly Violation[]) {
    super(
      `${violations.length} vi phạm bất biến:\n${violations
        .map((v) => `- [${v.invariant}] ${v.message}`)
        .join('\n')}`,
    );
    this.name = 'InvariantViolationError';
    this.violations = violations;
  }
}

export interface InvariantOptions {
  only?: readonly InvariantId[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Tiện ích
// ---------------------------------------------------------------------------------------------------------------------

/** Chạy một truy vấn bằng kết nối quản trị (thử lại một lần), lỗi thì ném. */
async function rows<R>(db: Kysely<unknown>, query: RawBuilder<R>): Promise<R[]> {
  const result = await adminQuery(db, (d) => query.execute(d));
  return result.rows;
}

/** Liệt kê tối đa `limit` id trong thông báo (phần còn lại ghi "+n") để thông báo vẫn đọc được khi có nhiều vi phạm. */
function listIds(ids: readonly string[], limit = 8): string {
  const shown = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${shown}, … (+${ids.length - limit})` : shown;
}

const num = (value: unknown): number => Number(value ?? 0);

interface Tenant {
  /** Tên tenant (không có tiền tố `t_`). */
  readonly name: string;
  readonly schema: string;
}

/** Tenant của hệ = mọi schema `t_<tenant>` có bảng `accounts` trong DB wallet (không phụ thuộc cấu hình truyền vào harness). */
async function discoverTenants(system: System): Promise<Tenant[]> {
  const found = await rows(
    system.walletAdmin,
    sql<{ name: string }>`
      select s.name from sys.schemas s
      where s.name like 't[_]%'
        and exists (select 1 from sys.tables t where t.schema_id = s.schema_id and t.name = 'accounts')
      order by s.name`,
  );
  if (found.length === 0) {
    throw new Error(
      'oracle bất biến: không tìm thấy tenant nào trong DB wallet (schema t_<tenant>)',
    );
  }
  // Tên schema đi vào sql.id (đã được trích dẫn), nhưng vẫn kiểm tra định dạng để không bao giờ truy vấn schema lạ.
  const bad = found.filter((row) => !/^t_[a-z0-9_-]+$/i.test(row.name));
  if (bad.length > 0) {
    throw new Error(
      `oracle bất biến: tên schema tenant không hợp lệ: ${bad.map((b) => b.name).join(', ')}`,
    );
  }
  return found.map((row) => ({ name: row.name.slice(2), schema: row.name }));
}

const table = (tenant: Tenant, name: string) => sql.id(tenant.schema, name);

/** Sự kiện kết quả đơn hàng mà Orders giả đã nhận. */
interface ReceivedEvent {
  eventType: string | undefined;
  messageId: string | undefined;
  tenant: string | undefined;
  orderId: string | undefined;
  walletTransactionId: string | undefined;
  amount: number | undefined;
  currency: string | undefined;
}

function receivedEvents(system: System): ReceivedEvent[] {
  return system.orders.received().map((r) => ({
    eventType: r.eventType,
    messageId: r.messageId,
    tenant: typeof r.payload.tenantId === 'string' ? r.payload.tenantId : undefined,
    orderId: typeof r.payload.orderId === 'string' ? r.payload.orderId : undefined,
    walletTransactionId:
      typeof r.payload.walletTransactionId === 'string' ? r.payload.walletTransactionId : undefined,
    amount: r.payload.amount === undefined ? undefined : num(r.payload.amount),
    currency: typeof r.payload.currency === 'string' ? r.payload.currency : undefined,
  }));
}

interface PaidOrder {
  orderId: string;
  transactionId: string;
  amount: number;
  currency: string;
}

async function loadPaidOrders(system: System, tenant: Tenant): Promise<Map<string, PaidOrder>> {
  const result = await rows(
    system.walletAdmin,
    sql<{ order_id: string; wallet_transaction_id: string; amount: string; currency: string }>`
      select order_id, wallet_transaction_id, amount, currency from ${table(tenant, 'order_payments')}`,
  );
  return new Map(
    result.map((r) => [
      r.order_id,
      {
        orderId: r.order_id,
        transactionId: r.wallet_transaction_id,
        amount: num(r.amount),
        currency: r.currency,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-1: sổ cái cân bằng
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sao chép logic SQL của `expectLedgerInvariants` (services/wallet/src/test-support.ts) thay vì import, để oracle không
 * phụ thuộc mã test của wallet. Khác bản gốc: tổng số dư tính THEO TỪNG ĐỒNG TIỀN (chặt hơn: +1 VND bù -1 USD vẫn bị bắt),
 * và thêm kiểm tra giao dịch không có dòng nào.
 */
async function checkInv1(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const tenant of tenants) {
    const sums = await rows(
      system.walletAdmin,
      sql<{ currency: string; total: string }>`
        select currency, sum(balance) as total from ${table(tenant, 'accounts')}
        group by currency having sum(balance) <> 0`,
    );
    for (const row of sums) {
      out.push({
        invariant: 'INV-1',
        code: 'TOTAL_NONZERO',
        message: `tenant ${tenant.name}: tổng số dư mọi tài khoản ${row.currency} = ${row.total} (phải bằng 0)`,
        detail: { tenant: tenant.name, currency: row.currency, total: String(row.total) },
      });
    }

    const drift = await rows(
      system.walletAdmin,
      sql<{ id: string; balance: string; ledger_total: string }>`
        select a.id, a.balance, coalesce(e.total, 0) as ledger_total
        from ${table(tenant, 'accounts')} a
        left join (
          select account_id, sum(amount) as total from ${table(tenant, 'ledger_entries')} group by account_id
        ) e on e.account_id = a.id
        where a.balance <> coalesce(e.total, 0)`,
    );
    if (drift.length > 0) {
      out.push({
        invariant: 'INV-1',
        code: 'BALANCE_DRIFT',
        message: `tenant ${tenant.name}: số dư lệch tổng các dòng sổ cái ở tài khoản ${listIds(
          drift.map((d) => `${d.id} (số dư ${d.balance}, sổ cái ${d.ledger_total})`),
        )}`,
        detail: { tenant: tenant.name, accountIds: drift.map((d) => d.id), drift },
      });
    }

    const unbalanced = await rows(
      system.walletAdmin,
      sql<{ transaction_id: string; total: string }>`
        select transaction_id, sum(amount) as total from ${table(tenant, 'ledger_entries')}
        group by transaction_id having sum(amount) <> 0`,
    );
    if (unbalanced.length > 0) {
      out.push({
        invariant: 'INV-1',
        code: 'TX_UNBALANCED',
        message: `tenant ${tenant.name}: giao dịch có tổng dòng khác 0: ${listIds(
          unbalanced.map((u) => `${u.transaction_id} (tổng ${u.total})`),
        )}`,
        detail: { tenant: tenant.name, transactionIds: unbalanced.map((u) => u.transaction_id) },
      });
    }

    const empty = await rows(
      system.walletAdmin,
      sql<{ id: string }>`
        select x.id from ${table(tenant, 'ledger_transactions')} x
        where not exists (select 1 from ${table(tenant, 'ledger_entries')} e where e.transaction_id = x.id)`,
    );
    if (empty.length > 0) {
      out.push({
        invariant: 'INV-1',
        code: 'TX_EMPTY',
        message: `tenant ${tenant.name}: giao dịch sổ cái không có dòng nào: ${listIds(empty.map((e) => e.id))}`,
        detail: { tenant: tenant.name, transactionIds: empty.map((e) => e.id) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-2: mỗi đơn chỉ bị ghi nợ một lần, khớp order_payments và OrderPaidV1
// ---------------------------------------------------------------------------------------------------------------------

async function checkInv2(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  const events = receivedEvents(system).filter((e) => e.eventType === 'OrderPaidV1');
  for (const tenant of tenants) {
    // (a) Giao dịch ORDER_PAYMENT mồ côi: không dòng order_payments nào trỏ tới nó (gồm cả giao dịch thứ hai cho cùng đơn).
    const orphans = await rows(
      system.walletAdmin,
      sql<{ id: string; business_key: string }>`
        select x.id, x.business_key from ${table(tenant, 'ledger_transactions')} x
        where x.kind = 'ORDER_PAYMENT'
          and not exists (select 1 from ${table(tenant, 'order_payments')} o where o.wallet_transaction_id = x.id)`,
    );
    if (orphans.length > 0) {
      out.push({
        invariant: 'INV-2',
        code: 'ORPHAN_ORDER_TX',
        message: `tenant ${tenant.name}: giao dịch ORDER_PAYMENT không có dòng order_payments (ghi nợ mồ côi / ghi nợ lần hai): ${listIds(
          orphans.map((o) => `${o.id} (${o.business_key})`),
        )}`,
        detail: { tenant: tenant.name, transactionIds: orphans.map((o) => o.id) },
      });
    }

    // (b) order_payments trỏ sai giao dịch: giao dịch không phải ORDER_PAYMENT hoặc business key không phải order:<orderId>.
    const misplaced = await rows(
      system.walletAdmin,
      sql<{ order_id: string; wallet_transaction_id: string }>`
        select o.order_id, o.wallet_transaction_id from ${table(tenant, 'order_payments')} o
        left join ${table(tenant, 'ledger_transactions')} x on x.id = o.wallet_transaction_id
        where x.id is null or x.kind <> 'ORDER_PAYMENT' or x.business_key <> concat('order:', o.order_id)`,
    );
    if (misplaced.length > 0) {
      out.push({
        invariant: 'INV-2',
        code: 'ORDER_PAYMENT_MISPLACED',
        message: `tenant ${tenant.name}: order_payments trỏ tới giao dịch không phải ORDER_PAYMENT của chính đơn đó: ${listIds(
          misplaced.map((m) => `order ${m.order_id} → ${m.wallet_transaction_id}`),
        )}`,
        detail: { tenant: tenant.name, orderIds: misplaced.map((m) => m.order_id) },
      });
    }

    // (c) Số tiền / đồng tiền của order_payments khác khoản ví bị ghi nợ thực tế trong sổ cái.
    const mismatched = await rows(
      system.walletAdmin,
      sql<{ order_id: string; amount: string; debited: string | null }>`
        select o.order_id, o.amount, d.debited
        from ${table(tenant, 'order_payments')} o
        left join (
          select e.transaction_id,
                 -sum(case when e.amount < 0 then e.amount else 0 end) as debited,
                 min(a.currency) as c1, max(a.currency) as c2
          from ${table(tenant, 'ledger_entries')} e
          join ${table(tenant, 'accounts')} a on a.id = e.account_id
          group by e.transaction_id
        ) d on d.transaction_id = o.wallet_transaction_id
        where d.transaction_id is null or d.debited <> o.amount or d.c1 <> o.currency or d.c2 <> o.currency`,
    );
    if (mismatched.length > 0) {
      out.push({
        invariant: 'INV-2',
        code: 'ORDER_PAYMENT_AMOUNT_MISMATCH',
        message: `tenant ${tenant.name}: order_payments lệch số tiền/đồng tiền so với sổ cái: ${listIds(
          mismatched.map(
            (m) => `order ${m.order_id} (order_payments ${m.amount}, sổ cái ${m.debited})`,
          ),
        )}`,
        detail: { tenant: tenant.name, orderIds: mismatched.map((m) => m.order_id) },
      });
    }

    // (d) Mọi OrderPaidV1 Orders giả đã nhận cho đơn có order_payments phải cùng walletTransactionId và số tiền,
    // và khớp order_payments (nên walletTransactionId tồn tại trong sổ cái). Đơn KHÔNG có order_payments do INV-4 lo.
    const paid = await loadPaidOrders(system, tenant);
    const byOrder = new Map<string, ReceivedEvent[]>();
    for (const event of events) {
      if (event.tenant !== tenant.name || event.orderId === undefined) continue;
      if (!paid.has(event.orderId)) continue;
      byOrder.set(event.orderId, [...(byOrder.get(event.orderId) ?? []), event]);
    }
    for (const [orderId, group] of byOrder) {
      const expected = paid.get(orderId) as PaidOrder;
      const bad = group.filter(
        (e) =>
          e.walletTransactionId !== expected.transactionId ||
          e.amount !== expected.amount ||
          e.currency !== expected.currency,
      );
      if (bad.length === 0) continue;
      out.push({
        invariant: 'INV-2',
        code: 'RECEIVED_PAID_MISMATCH',
        message: `tenant ${tenant.name}: đơn ${orderId} có OrderPaidV1 (messageId ${listIds(
          bad.map((e) => String(e.messageId)),
        )}) khác khoản trả trong sổ cái ${expected.transactionId}/${expected.amount} ${expected.currency}: ${bad
          .map((e) => `${e.walletTransactionId}/${e.amount} ${e.currency}`)
          .join('; ')}`,
        detail: { tenant: tenant.name, orderId, expected, received: bad },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-3: nạp tiền khớp giữa wallet và payment
// ---------------------------------------------------------------------------------------------------------------------

interface TopupRow {
  id: string;
  account_id: string;
  amount: string;
  currency: string;
  status: string;
  charge_id: string | null;
  failure_code: string | null;
}

interface ChargeRow {
  id: string;
  reference: string;
  amount: string;
  currency: string;
  status: string;
  metadata: string | null;
}

/** Tenant của một charge: wallet gửi `metadata.tenantId` khi tạo charge (submit-topup.ts) và đối soát cũng dựa vào đó. */
function chargeTenant(metadata: string | null): string | undefined {
  if (metadata === null) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { tenantId?: unknown };
    return typeof parsed.tenantId === 'string' ? parsed.tenantId : undefined;
  } catch {
    return undefined;
  }
}

async function checkInv3(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  const charges = await rows(
    system.paymentAdmin,
    sql<ChargeRow>`select id, reference, amount, currency, status, metadata from charges`,
  );
  const keys = await rows(
    system.paymentAdmin,
    sql<{
      idempotency_key: string;
      charge_id: string;
    }>`select idempotency_key, charge_id from idempotency_keys`,
  );
  const chargeById = new Map(charges.map((c) => [c.id, c]));

  // Phía wallet, theo tenant.
  const topupsOf = new Map<string, Map<string, TopupRow>>();
  const ledgerTotals = new Map<string, number>(); // `${tenant}|${currency}` → tổng TOPUP trong sổ cái
  const chargeRefs = new Map<string, string[]>(); // chargeId → ['tenant/topupId']
  for (const tenant of tenants) {
    const topups = await rows(
      system.walletAdmin,
      sql<TopupRow>`select id, account_id, amount, currency, status, charge_id, failure_code from ${table(tenant, 'topups')}`,
    );
    topupsOf.set(tenant.name, new Map(topups.map((t) => [t.id, t])));
    for (const topup of topups) {
      if (topup.charge_id === null) continue;
      chargeRefs.set(topup.charge_id, [
        ...(chargeRefs.get(topup.charge_id) ?? []),
        `${tenant.name}/${topup.id}`,
      ]);
    }

    const entries = await rows(
      system.walletAdmin,
      sql<{
        id: string;
        business_key: string;
        account_id: string | null;
        amount: string | null;
        currency: string | null;
      }>`
        select x.id, x.business_key, e.account_id, e.amount, a.currency
        from ${table(tenant, 'ledger_transactions')} x
        left join ${table(tenant, 'ledger_entries')} e on e.transaction_id = x.id
        left join ${table(tenant, 'accounts')} a on a.id = e.account_id
        where x.kind = 'TOPUP'`,
    );
    const txns = new Map<string, { businessKey: string; credits: Map<string, number> }>();
    for (const entry of entries) {
      const txn = txns.get(entry.id) ?? { businessKey: entry.business_key, credits: new Map() };
      txns.set(entry.id, txn);
      if (entry.account_id !== null && num(entry.amount) > 0) {
        txn.credits.set(
          entry.account_id,
          (txn.credits.get(entry.account_id) ?? 0) + num(entry.amount),
        );
        const key = `${tenant.name}|${entry.currency}`;
        ledgerTotals.set(key, (ledgerTotals.get(key) ?? 0) + num(entry.amount));
      }
    }
    const txnByTopup = new Map(
      [...txns].map(([id, txn]) => [txn.businessKey.replace(/^topup:/, ''), { id, ...txn }]),
    );

    // (a) topup SUCCEEDED phải có đúng một giao dịch TOPUP (business key duy nhất) với số tiền khớp.
    const topupMap = topupsOf.get(tenant.name) as Map<string, TopupRow>;
    const missingTxn: string[] = [];
    const wrongAmount: string[] = [];
    for (const topup of topups) {
      if (topup.status !== 'SUCCEEDED') continue;
      const txn = txnByTopup.get(topup.id);
      if (txn === undefined) missingTxn.push(topup.id);
      else if ((txn.credits.get(topup.account_id) ?? 0) !== num(topup.amount)) {
        wrongAmount.push(
          `${topup.id} (topup ${topup.amount}, sổ cái ${txn.credits.get(topup.account_id) ?? 0})`,
        );
      }
    }
    if (missingTxn.length > 0) {
      out.push({
        invariant: 'INV-3',
        code: 'TOPUP_TX_MISSING',
        message: `tenant ${tenant.name}: topup SUCCEEDED không có giao dịch TOPUP trong sổ cái: ${listIds(missingTxn)}`,
        detail: { tenant: tenant.name, topupIds: missingTxn },
      });
    }
    if (wrongAmount.length > 0) {
      out.push({
        invariant: 'INV-3',
        code: 'TOPUP_TX_AMOUNT_MISMATCH',
        message: `tenant ${tenant.name}: số tiền topup lệch giao dịch TOPUP: ${listIds(wrongAmount)}`,
        detail: { tenant: tenant.name, topups: wrongAmount },
      });
    }

    // (b) ngược lại: giao dịch TOPUP phải thuộc một topup SUCCEEDED.
    const stray = [...txns]
      .filter(
        ([, txn]) => topupMap.get(txn.businessKey.replace(/^topup:/, ''))?.status !== 'SUCCEEDED',
      )
      .map(([id, txn]) => `${id} (${txn.businessKey})`);
    if (stray.length > 0) {
      out.push({
        invariant: 'INV-3',
        code: 'TX_WITHOUT_SUCCEEDED_TOPUP',
        message: `tenant ${tenant.name}: giao dịch TOPUP không thuộc topup SUCCEEDED nào: ${listIds(stray)}`,
        detail: { tenant: tenant.name, transactions: stray },
      });
    }

    // (c) topup SUCCEEDED phải có charge SUCCEEDED bên payment, đúng số tiền và đồng tiền.
    for (const topup of topups) {
      if (topup.status !== 'SUCCEEDED') continue;
      const charge = topup.charge_id === null ? undefined : chargeById.get(topup.charge_id);
      if (
        charge === undefined ||
        charge.status !== 'SUCCEEDED' ||
        num(charge.amount) !== num(topup.amount) ||
        charge.currency !== topup.currency
      ) {
        out.push({
          invariant: 'INV-3',
          code: 'TOPUP_CHARGE_NOT_SUCCEEDED',
          message: `tenant ${tenant.name}: topup SUCCEEDED ${topup.id} không có charge SUCCEEDED khớp bên payment (charge ${topup.charge_id ?? 'null'}: ${
            charge === undefined
              ? 'không có'
              : `${charge.status} ${charge.amount} ${charge.currency}`
          })`,
          detail: {
            tenant: tenant.name,
            topupId: topup.id,
            topupStatus: topup.status,
            chargeId: topup.charge_id,
            chargeStatus: charge?.status ?? null,
            amount: num(topup.amount),
            currency: topup.currency,
          },
        });
      }
    }
  }

  // (d) charge SUCCEEDED bên payment phải thuộc một tenant của hệ và một topup SUCCEEDED khớp (reference = topupId).
  const chargeTotals = new Map<string, number>();
  for (const charge of charges) {
    if (charge.status !== 'SUCCEEDED') continue;
    const tenantName = chargeTenant(charge.metadata);
    const topups = tenantName === undefined ? undefined : topupsOf.get(tenantName);
    if (tenantName === undefined || topups === undefined) {
      out.push({
        invariant: 'INV-3',
        code: 'CHARGE_UNATTRIBUTED',
        message: `charge SUCCEEDED không gán được cho tenant nào của hệ: ${charge.id} (tenant ${tenantName ?? 'không có'})`,
        detail: {
          chargeId: charge.id,
          topupId: charge.reference,
          tenant: tenantName ?? null,
          amount: num(charge.amount),
          currency: charge.currency,
        },
      });
      continue;
    }
    const key = `${tenantName}|${charge.currency}`;
    chargeTotals.set(key, (chargeTotals.get(key) ?? 0) + num(charge.amount));
    const topup = topups.get(charge.reference);
    const base = {
      tenant: tenantName,
      chargeId: charge.id,
      topupId: charge.reference,
      chargeStatus: charge.status,
      amount: num(charge.amount),
      currency: charge.currency,
    };
    if (topup === undefined) {
      out.push({
        invariant: 'INV-3',
        code: 'CHARGE_WITHOUT_TOPUP',
        message: `tenant ${tenantName}: charge SUCCEEDED ${charge.id} không có topup SUCCEEDED khớp bên wallet (reference ${charge.reference}, ${charge.amount} ${charge.currency}, không có topup)`,
        detail: { ...base, topupStatus: null, failureCode: null },
      });
    } else if (topup.status !== 'SUCCEEDED') {
      out.push({
        invariant: 'INV-3',
        code: 'CHARGE_TOPUP_NOT_SUCCEEDED',
        message: `tenant ${tenantName}: charge SUCCEEDED ${charge.id} không có topup SUCCEEDED khớp bên wallet (reference ${charge.reference}, ${charge.amount} ${charge.currency}, topup ${topup.status}${
          topup.failure_code === null ? '' : ` ${topup.failure_code}`
        })`,
        detail: { ...base, topupStatus: topup.status, failureCode: topup.failure_code },
      });
    } else if (
      topup.charge_id !== charge.id ||
      num(topup.amount) !== num(charge.amount) ||
      topup.currency !== charge.currency
    ) {
      out.push({
        invariant: 'INV-3',
        code: 'CHARGE_TOPUP_MISMATCH',
        message: `tenant ${tenantName}: charge SUCCEEDED ${charge.id} không có topup SUCCEEDED khớp bên wallet (reference ${charge.reference}: topup charge_id ${topup.charge_id}, ${topup.amount} ${topup.currency} ≠ charge ${charge.amount} ${charge.currency})`,
        detail: { ...base, topupStatus: topup.status, failureCode: topup.failure_code },
      });
    }
  }

  // (e) tổng theo tenant + đồng tiền: TOPUP trong sổ cái = charge SUCCEEDED bên payment.
  for (const key of [...new Set([...ledgerTotals.keys(), ...chargeTotals.keys()])].sort()) {
    const ledger = ledgerTotals.get(key) ?? 0;
    const gateway = chargeTotals.get(key) ?? 0;
    if (ledger === gateway) continue;
    const [tenantName, currency] = key.split('|');
    out.push({
      invariant: 'INV-3',
      code: 'SUM_MISMATCH',
      message: `tenant ${tenantName}: tổng TOPUP trong sổ cái ${ledger} ${currency} ≠ tổng charge SUCCEEDED bên payment ${gateway} ${currency}`,
      detail: { tenant: tenantName, currency, ledger, gateway },
    });
  }

  // (f) mỗi topup có tối đa một charge; mỗi charge_id chỉ gắn một topup.
  const sharedCharge = [...chargeRefs].filter(([, refs]) => refs.length > 1);
  if (sharedCharge.length > 0) {
    out.push({
      invariant: 'INV-3',
      code: 'DUPLICATE_CHARGE_ID',
      message: `charge_id gắn cho nhiều topup: ${listIds(
        sharedCharge.map(([id, refs]) => `${id} ← ${refs.join(' & ')}`),
      )}`,
      detail: { charges: sharedCharge.map(([id]) => id) },
    });
  }
  const byReference = new Map<string, string[]>();
  for (const charge of charges) {
    byReference.set(charge.reference, [...(byReference.get(charge.reference) ?? []), charge.id]);
  }
  const doubled = [...byReference].filter(([, ids]) => ids.length > 1);
  if (doubled.length > 0) {
    out.push({
      invariant: 'INV-3',
      code: 'DUPLICATE_CHARGE_REF',
      message: `nhiều charge cho cùng một reference (nguy cơ thu tiền hai lần): ${listIds(
        doubled.map(([reference, ids]) => `${reference} → ${ids.join(' & ')}`),
      )}`,
      detail: { references: doubled.map(([reference]) => reference) },
    });
  }

  // (g) idempotency key bên payment: mỗi charge chỉ có một khóa, và khóa `topup:<tenant>:<topupId>` phải trỏ đúng charge.
  // (Bản thân một khóa → tối đa một charge đã do khóa chính của bảng bảo đảm, không cần kiểm tra lại.)
  const keysByCharge = new Map<string, string[]>();
  const wrongKey: string[] = [];
  for (const row of keys) {
    keysByCharge.set(row.charge_id, [
      ...(keysByCharge.get(row.charge_id) ?? []),
      row.idempotency_key,
    ]);
    const match = /^topup:([^:]+):(.+)$/.exec(row.idempotency_key);
    const charge = chargeById.get(row.charge_id);
    if (match === null || charge === undefined) continue;
    if (charge.reference !== match[2] || chargeTenant(charge.metadata) !== match[1]) {
      wrongKey.push(`${row.idempotency_key} → ${row.charge_id} (reference ${charge.reference})`);
    }
  }
  const manyKeys = [...keysByCharge].filter(([, list]) => list.length > 1);
  if (manyKeys.length > 0) {
    out.push({
      invariant: 'INV-3',
      code: 'CHARGE_MULTIPLE_KEYS',
      message: `charge có nhiều idempotency key: ${listIds(manyKeys.map(([id, list]) => `${id} ← ${list.join(' & ')}`))}`,
      detail: { charges: manyKeys.map(([id]) => id) },
    });
  }
  if (wrongKey.length > 0) {
    out.push({
      invariant: 'INV-3',
      code: 'KEY_CHARGE_MISMATCH',
      message: `idempotency key trỏ tới charge của topup/tenant khác: ${listIds(wrongKey)}`,
      detail: { keys: wrongKey },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-4: outbox đã gửi hết và Orders nhận đủ kết quả
// ---------------------------------------------------------------------------------------------------------------------

async function checkInv4(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  const events = receivedEvents(system);
  const receivedIds = new Set(events.map((e) => e.messageId));
  const receivedPaid = events.filter((e) => e.eventType === 'OrderPaidV1');
  const known = new Set(tenants.map((t) => t.name));

  for (const tenant of tenants) {
    // (a) Không còn dòng outbox nào chưa SENT.
    const pending = await rows(
      system.walletAdmin,
      sql<{ id: string; event_type: string; status: string; attempts: number }>`
        select id, event_type, status, attempts from ${table(tenant, 'outbox')} where status <> 'SENT'`,
    );
    if (pending.length > 0) {
      out.push({
        invariant: 'INV-4',
        code: 'OUTBOX_NOT_SENT',
        message: `tenant ${tenant.name}: outbox còn dòng chưa SENT: ${listIds(
          pending.map((p) => `${p.id} (${p.event_type}, ${p.status}, ${p.attempts} lần thử)`),
        )}`,
        detail: { tenant: tenant.name, outboxIds: pending.map((p) => p.id) },
      });
    }

    const resultRows = await rows(
      system.walletAdmin,
      sql<{ id: string; event_type: string; status: string; order_id: string | null }>`
        select id, event_type, status, json_value(payload, '$.orderId') as order_id
        from ${table(tenant, 'outbox')}
        where event_type in ('OrderPaidV1', 'OrderPaymentFailedV1')`,
    );
    const paid = await loadPaidOrders(system, tenant);

    // (b) Dòng kết quả đã SENT (OrderPaidV1 và cả OrderPaymentFailedV1 của lần từ chối đã commit) phải đã tới Orders giả.
    const lost = resultRows.filter((r) => r.status === 'SENT' && !receivedIds.has(r.id));
    if (lost.length > 0) {
      out.push({
        invariant: 'INV-4',
        code: 'SENT_NOT_RECEIVED',
        message: `tenant ${tenant.name}: outbox đã SENT nhưng Orders giả chưa nhận: ${listIds(
          lost.map((r) => `${r.id} (${r.event_type}, order ${r.order_id})`),
        )}`,
        detail: {
          tenant: tenant.name,
          outboxIds: lost.map((r) => r.id),
          orderIds: lost.map((r) => r.order_id),
        },
      });
    }

    // (c) Mỗi order_payments phải có ít nhất một OrderPaidV1 đã tới Orders giả.
    const silent = [...paid.keys()].filter(
      (orderId) => !receivedPaid.some((e) => e.tenant === tenant.name && e.orderId === orderId),
    );
    if (silent.length > 0) {
      out.push({
        invariant: 'INV-4',
        code: 'PAID_NOT_RECEIVED',
        message: `tenant ${tenant.name}: đơn đã trả nhưng Orders giả chưa nhận OrderPaidV1: ${listIds(silent)}`,
        detail: { tenant: tenant.name, orderIds: silent },
      });
    }

    // (d) Không có OrderPaidV1 (trong outbox) nào cho đơn không có order_payments.
    const phantom = resultRows.filter(
      (r) => r.event_type === 'OrderPaidV1' && (r.order_id === null || !paid.has(r.order_id)),
    );
    if (phantom.length > 0) {
      out.push({
        invariant: 'INV-4',
        code: 'OUTBOX_PAID_UNKNOWN_ORDER',
        message: `tenant ${tenant.name}: outbox có OrderPaidV1 cho đơn không có order_payments: ${listIds(
          phantom.map((r) => `${r.id} (order ${r.order_id})`),
        )}`,
        detail: { tenant: tenant.name, outboxIds: phantom.map((r) => r.id) },
      });
    }
  }

  // (d') ... và Orders giả cũng không được nhận OrderPaidV1 cho đơn không có order_payments (kể cả tenant lạ).
  const paidByTenant = new Map<string, Map<string, PaidOrder>>();
  for (const tenant of tenants) paidByTenant.set(tenant.name, await loadPaidOrders(system, tenant));
  const phantomReceived = receivedPaid.filter(
    (e) =>
      e.tenant === undefined ||
      e.orderId === undefined ||
      !known.has(e.tenant) ||
      !(paidByTenant.get(e.tenant) as Map<string, PaidOrder>).has(e.orderId),
  );
  if (phantomReceived.length > 0) {
    out.push({
      invariant: 'INV-4',
      code: 'RECEIVED_PAID_UNKNOWN_ORDER',
      message: `Orders giả đã nhận OrderPaidV1 cho đơn không có order_payments: ${listIds(
        phantomReceived.map((e) => `${e.messageId} (tenant ${e.tenant}, order ${e.orderId})`),
      )}`,
      detail: { messageIds: phantomReceived.map((e) => e.messageId) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------------------

type Check = (system: System, tenants: Tenant[]) => Promise<Violation[]>;

const CHECKS: Partial<Record<InvariantId, Check>> = {
  'INV-1': checkInv1,
  'INV-2': checkInv2,
  'INV-3': checkInv3,
  'INV-4': checkInv4,
};

/** Thu mọi vi phạm của các bất biến đã chọn (mặc định: tất cả bất biến đã cài). Lỗi truy vấn được ném, không bao giờ thành "đạt". */
export async function collectViolations(
  system: System,
  options: InvariantOptions = {},
): Promise<Violation[]> {
  const selected = options.only ?? (Object.keys(CHECKS) as InvariantId[]);
  for (const id of selected) {
    if (CHECKS[id] === undefined) throw new Error(`bất biến ${id} chưa được cài trong oracle`);
  }
  const tenants = await discoverTenants(system);
  const out: Violation[] = [];
  for (const id of selected) {
    out.push(...(await (CHECKS[id] as Check)(system, tenants)));
  }
  return out;
}

/**
 * Vi phạm kiểu "MISSING_AT_WALLET": payment đã chốt charge SUCCEEDED nhưng wallet chưa ghi có
 * (topup còn REQUESTED/PENDING, hoặc FAILED vì PAYMENT_UNAVAILABLE — trường hợp webhook thành công đến muộn mà đối soát
 * sẽ ghi bù). Đây là trạng thái đối soát (S7) sửa được, khác với hỏng dữ liệu thật.
 */
export function isMissingAtWallet(violation: Violation): boolean {
  if (violation.invariant !== 'INV-3' || violation.code !== 'CHARGE_TOPUP_NOT_SUCCEEDED') {
    return false;
  }
  const detail = violation.detail ?? {};
  if (detail.chargeStatus !== 'SUCCEEDED') return false;
  if (detail.topupStatus === 'REQUESTED' || detail.topupStatus === 'PENDING') return true;
  return detail.topupStatus === 'FAILED' && detail.failureCode === 'PAYMENT_UNAVAILABLE';
}

/**
 * Đúng khi TOÀN BỘ vi phạm đều thuộc INV-3 và được giải thích hết bởi các charge MISSING_AT_WALLET: mọi vi phạm là
 * MISSING_AT_WALLET hoặc SUM_MISMATCH, và với mỗi tenant+đồng tiền, (tổng charge − tổng sổ cái) của SUM_MISMATCH đúng bằng
 * tổng số tiền các charge MISSING_AT_WALLET của tenant+đồng tiền đó (không thừa, không thiếu). Rỗng ⇒ false.
 */
export function explainedByMissingAtWallet(violations: readonly Violation[]): boolean {
  if (violations.length === 0) return false;
  const missing = violations.filter(isMissingAtWallet);
  const sums = violations.filter((v) => v.invariant === 'INV-3' && v.code === 'SUM_MISMATCH');
  if (missing.length === 0 || missing.length + sums.length !== violations.length) return false;

  const expected = new Map<string, number>();
  for (const v of missing) {
    const key = `${String(v.detail?.tenant)}|${String(v.detail?.currency)}`;
    expected.set(key, (expected.get(key) ?? 0) + num(v.detail?.amount));
  }
  const actual = new Map<string, number>();
  for (const v of sums) {
    const key = `${String(v.detail?.tenant)}|${String(v.detail?.currency)}`;
    if (actual.has(key)) return false;
    actual.set(key, num(v.detail?.gateway) - num(v.detail?.ledger));
  }
  if (actual.size !== expected.size) return false;
  for (const [key, amount] of expected) {
    if (actual.get(key) !== amount) return false;
  }
  return true;
}

/** Ném InvariantViolationError nêu từng vi phạm cùng id cụ thể (tenant, orderId, topupId, accountId…). */
export async function assertSystemInvariants(
  system: System,
  options: InvariantOptions = {},
): Promise<void> {
  const violations = await collectViolations(system, options);
  if (violations.length > 0) throw new InvariantViolationError(violations);
}
