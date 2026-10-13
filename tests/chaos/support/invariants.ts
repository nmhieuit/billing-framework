import { waitFor } from '@billing/testing';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { isProcessAlive } from './crash.js';
import { adminQuery, type System } from './system-harness.js';

/**
 * Oracle bất biến của hệ chaos (spec §3). Chạy SAU heal() trên mọi tenant của hệ, chỉ đọc, bằng kết nối quản trị
 * KHÔNG bị plan can thiệp (walletAdmin / paymentAdmin); riêng INV-5 gọi API đối soát của wallet (CÓ ghi bù) và INV-8 gọi
 * HTTP của hai dịch vụ. Đầu vào chính: assertSystemInvariants/runInvariants (thứ tự kiểm tra bắt buộc, xem runInvariants);
 * collectViolations là một lượt CHỈ ĐỌC các bất biến chọn (không có INV-5).
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
 *         | PAID_WITHOUT_OUTBOX (chỉ khi retention không xóa thật: dòng outbox SENT có thể đã bị dọn)
 *  INV-5  RECONCILIATION_RUN_FAILED | LEDGER_UNBALANCED_OPEN | BALANCE_MISMATCH_OPEN | MISSING_AT_WALLET_UNFIXED
 *         | RECONCILIATION_TOO_LARGE | RECONCILIATION_ITEM_OPEN (loại khác còn OPEN) | AUTOFIX_UNEXPECTED | AUTOFIX_MISSING
 *         | RECONCILIATION_NOT_CONVERGED (lượt thứ hai vẫn thấy sai lệch)
 *  INV-6  OPS_DUPLICATE_KEY | OPS_DUPLICATE_ID | ADJUST_TX_MISSING | ADJUST_TX_WRONG_WALLET | ADJUST_TX_RESULT_MISMATCH
 *         | REVERSE_TX_MISSING | REVERSE_TX_RESULT_MISMATCH | REVERSE_ACTION_DUPLICATE | FREEZE_STATE_MISMATCH
 *         | ADJUSTMENT_TX_ORPHAN | REVERSAL_TX_ORPHAN | REPLAY_OUTBOX_MISSING | REPLAY_OUTBOX_MISMATCH | REPLAY_OUTBOX_ORPHAN
 *  INV-7  ACKED_ORDER_MISSING | ACKED_TOPUP_MISSING | ACKED_OPS_ACTION_MISSING
 *  INV-8  HEALTH_FAILED | READ_FAILED | SERVICE_DOWN
 *  Vi phạm tìm thấy lúc kiểm lại SAU đối soát mang thêm `detail.phase = 'after-reconciliation'`.
 *
 * Retention THẬT (System.retentionDeletes): outbox SENT / idempotency key / processed_messages có thể đã bị dọn. Mọi kiểm tra
 * trong oracle chỉ nhìn các dòng còn lại nên không báo oan; riêng kiểm tra "đã trả thì còn dòng outbox OrderPaidV1"
 * (PAID_WITHOUT_OUTBOX) cần dòng đã dọn nên chỉ chạy khi retention không xóa thật. INV-3 phần idempotency key chỉ xét khóa
 * còn tồn tại nên dung thứ khóa đã bị dọn.
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
  /** Chỉ chạy các bất biến này (luôn theo thứ tự chuẩn); INV-5 đòi kèm đủ INV-1..4 (xem runInvariants). */
  only?: readonly InvariantId[];
  /**
   * Webhook thành công bị mất CÓ CHỦ Ý (S7): trước đối soát INV-3 được phép còn đúng các trạng thái MISSING_AT_WALLET
   * (explainedByMissingAtWallet), đối soát phải ghi bù đúng tập charge đó; sau đối soát INV-3 vẫn phải chặt.
   */
  expectMissingAtWallet?: boolean;
  /** Ngày UTC `YYYY-MM-DD` đối soát thêm ngoài các ngày suy ra từ dữ liệu. */
  reconcileDays?: string[];
  /** Chỉ dành cho test của chính oracle: thay cách chạy một lượt đối soát (mặc định gọi API HTTP của wallet). */
  reconcileRunner?: ReconcileRunner;
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

interface TopupLedgerEntry {
  id: string;
  business_key: string;
  account_id: string | null;
  amount: string | null;
  currency: string | null;
}

/**
 * Đọc phía wallet (hàm `read`) trong MỘT giao dịch SNAPSHOT: mọi truy vấn trong đó thấy cùng một thời điểm nhất quán. Không có
 * nó, một lần nạp hoàn tất giữa hai truy vấn (topup PENDING đọc trước, giao dịch sổ cái vừa ghi đọc sau) tạo ra vi phạm giả
 * dù ApplyPaymentResult ghi sổ cái và cập nhật topup trong cùng một transaction. Harness bật ALLOW_SNAPSHOT_ISOLATION cho DB wallet.
 */
export function readWalletSnapshot<T>(
  system: System,
  read: (db: Kysely<unknown>) => Promise<T>,
): Promise<T> {
  return adminQuery(system.walletAdmin, (db) =>
    db
      .transaction()
      .setIsolationLevel('snapshot')
      .execute((trx) => read(trx)),
  );
}

async function checkInv3(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  // THỨ TỰ NHÂN QUẢ: đọc wallet (một snapshot) TRƯỚC payment. Ghi có ở wallet luôn theo sau charge SUCCEEDED bên payment, nên
  // phần đọc payment (muộn hơn) chắc chắn thấy mọi charge mà wallet đã ghi có; đọc ngược lại thì charge/topup lệch pha.
  const walletSide = await readWalletSnapshot(system, async (db) => {
    const read = new Map<string, { topups: TopupRow[]; entries: TopupLedgerEntry[] }>();
    for (const tenant of tenants) {
      const topups = (
        await sql<TopupRow>`select id, account_id, amount, currency, status, charge_id, failure_code from ${table(tenant, 'topups')}`.execute(
          db,
        )
      ).rows;
      const entries = (
        await sql<TopupLedgerEntry>`
        select x.id, x.business_key, e.account_id, e.amount, a.currency
        from ${table(tenant, 'ledger_transactions')} x
        left join ${table(tenant, 'ledger_entries')} e on e.transaction_id = x.id
        left join ${table(tenant, 'accounts')} a on a.id = e.account_id
        where x.kind = 'TOPUP'`.execute(db)
      ).rows;
      read.set(tenant.name, { topups, entries });
    }
    return read;
  });
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
    const { topups, entries } = walletSide.get(tenant.name) as {
      topups: TopupRow[];
      entries: TopupLedgerEntry[];
    };
    topupsOf.set(tenant.name, new Map(topups.map((t) => [t.id, t])));
    for (const topup of topups) {
      if (topup.charge_id === null) continue;
      chargeRefs.set(topup.charge_id, [
        ...(chargeRefs.get(topup.charge_id) ?? []),
        `${tenant.name}/${topup.id}`,
      ]);
    }

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

    // (e) ngược lại: mỗi đơn đã trả phải còn dòng outbox OrderPaidV1 của nó. Retention thật dọn dòng SENT cũ nên khi đó bỏ qua.
    if (!system.retentionDeletes) {
      const withRow = new Set(
        resultRows.filter((r) => r.event_type === 'OrderPaidV1').map((r) => r.order_id),
      );
      const lostRow = [...paid.keys()].filter((orderId) => !withRow.has(orderId));
      if (lostRow.length > 0) {
        out.push({
          invariant: 'INV-4',
          code: 'PAID_WITHOUT_OUTBOX',
          message: `tenant ${tenant.name}: đơn đã trả nhưng không có dòng outbox OrderPaidV1: ${listIds(lostRow)}`,
          detail: { tenant: tenant.name, orderIds: lostRow },
        });
      }
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
// INV-5: đối soát với payment (chạy qua HTTP của wallet, CÓ ghi bù khi autofix bật)
// ---------------------------------------------------------------------------------------------------------------------

export interface ReconcileItem {
  id: string;
  kind: string;
  chargeId: string | null;
  topupId: string | null;
  action: string;
  caseStatus: string;
  detail: Record<string, unknown>;
}

export interface ReconcileRun {
  tenant: string;
  day: string;
  runId: string;
  status: string;
  failureReason: string | null;
  /** Tổng theo đồng tiền mà lượt đối soát đã đọc từ payment / từ wallet (cùng ngày). */
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
  items: ReconcileItem[];
}

/** Chạy một lượt đối soát cho (tenant, ngày); tách thành hàm để test của oracle thay thế (xem InvariantOptions.reconcileRunner). */
export type ReconcileRunner = (
  system: System,
  tenant: string,
  day: string,
  /** 1 = lượt đối soát (có ghi bù), 2 = lượt kiểm hội tụ. */
  pass: 1 | 2,
) => Promise<ReconcileRun>;

export const RECONCILE_TIMEOUT_MS = 60_000;

async function walletJson<T>(
  system: System,
  tenant: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; expect: number },
): Promise<T> {
  const response = await fetch(`${system.walletUrl}${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenant },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status !== init.expect) {
    throw new Error(
      `đối soát: ${init.method} ${path} (tenant ${tenant}) trả ${response.status}, mong ${init.expect}: ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as T;
}

/**
 * Đối soát THỦ CÔNG qua API của wallet: `POST /reconciliations` {date} → chờ `GET /reconciliations/:id` rời RUNNING →
 * đọc hết `GET /reconciliations/:id/items` (theo cursor). Mọi phản hồi lạ đều ném lỗi.
 */
export const reconciliationRunner =
  (pageSize = 500): ReconcileRunner =>
  async (system, tenant, day) => {
    const { runId } = await walletJson<{ runId: string }>(system, tenant, '/reconciliations', {
      method: 'POST',
      body: { date: day },
      expect: 202,
    });
    let run:
      | {
          status: string;
          failureReason: string | null;
          gatewayTotals: Record<string, number>;
          walletTotals: Record<string, number>;
        }
      | undefined;
    await waitFor(
      async () => {
        run = await walletJson(system, tenant, `/reconciliations/${runId}`, {
          method: 'GET',
          expect: 200,
        });
        return run?.status !== 'RUNNING';
      },
      { timeoutMs: RECONCILE_TIMEOUT_MS, intervalMs: 100 },
    );
    const finished = run as NonNullable<typeof run>;
    const items: ReconcileItem[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: ReconcileItem[]; nextCursor: string | null } = await walletJson(
        system,
        tenant,
        `/reconciliations/${runId}/items?limit=${pageSize}${cursor === null ? '' : `&cursor=${cursor}`}`,
        { method: 'GET', expect: 200 },
      );
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return {
      tenant,
      day,
      runId,
      status: finished.status,
      failureReason: finished.failureReason,
      gatewayTotals: finished.gatewayTotals,
      walletTotals: finished.walletTotals,
      items,
    };
  };

/** Runner mặc định: cỡ trang 500 (tối đa của API). */
export const runReconciliationViaHttp: ReconcileRunner = reconciliationRunner();

const addDays = (day: string, delta: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/**
 * Các ngày UTC cần đối soát, suy ra từ DỮ LIỆU (không từ đồng hồ, vì test có thể vắt qua nửa đêm): ngày của mọi charge bên
 * payment và mọi topup bên wallet (tạo/hoàn tất), cộng ngày liền trước mỗi ngày đó (đối soát tra cứu ngày D-1) và các ngày
 * người gọi chỉ định. Bỏ ngày tương lai (wallet từ chối). Không có dữ liệu thì lấy hôm nay.
 */
export async function reconcileDaysOf(
  system: System,
  tenants: Tenant[],
  extra: readonly string[],
): Promise<string[]> {
  const days = new Set<string>(extra);
  const charges = await rows(
    system.paymentAdmin,
    sql<{ d: string }>`
      select distinct convert(char(10), completed_at, 23) as d from charges where completed_at is not null
      union select distinct convert(char(10), created_at, 23) from charges`,
  );
  for (const row of charges) days.add(row.d);
  for (const tenant of tenants) {
    const topups = await rows(
      system.walletAdmin,
      sql<{ d: string }>`
        select distinct convert(char(10), completed_at, 23) as d from ${table(tenant, 'topups')} where completed_at is not null
        union select distinct convert(char(10), created_at, 23) from ${table(tenant, 'topups')}`,
    );
    for (const row of topups) days.add(row.d);
  }
  const today = new Date().toISOString().slice(0, 10);
  const all = new Set<string>();
  for (const day of days) {
    all.add(day);
    all.add(addDays(day, -1));
  }
  if (all.size === 0) all.add(today);
  return [...all].filter((day) => day <= today).sort();
}

interface Reconciled {
  runs: ReconcileRun[];
  violations: Violation[];
  /** `<tenant>/<chargeId>` của các item MISSING_AT_WALLET đã AUTO_APPLIED. */
  autoApplied: Set<string>;
}

async function reconcileAll(
  system: System,
  tenants: Tenant[],
  extraDays: readonly string[],
  runner: ReconcileRunner,
  pass: 1 | 2,
): Promise<{ days: string[]; runs: ReconcileRun[] }> {
  const days = await reconcileDaysOf(system, tenants, extraDays);
  const runs = await Promise.all(
    tenants.flatMap((tenant) => days.map((day) => runner(system, tenant.name, day, pass))),
  );
  return { days, runs };
}

function judgeFirstPass(runs: readonly ReconcileRun[]): Reconciled {
  const violations: Violation[] = [];
  const autoApplied = new Set<string>();
  for (const run of runs) {
    const where = { tenant: run.tenant, day: run.day, runId: run.runId };
    if (run.status !== 'COMPLETED') {
      violations.push({
        invariant: 'INV-5',
        // Vượt trần maxItems của cấu hình đối soát là lỗi cấu hình harness, khác với đối soát hỏng thật.
        code: /more than/i.test(run.failureReason ?? '')
          ? 'RECONCILIATION_TOO_LARGE'
          : 'RECONCILIATION_RUN_FAILED',
        message: `tenant ${run.tenant}: lượt đối soát ngày ${run.day} (${run.runId}) kết thúc ${run.status}: ${run.failureReason ?? 'không rõ lý do'}`,
        detail: { ...where, status: run.status, failureReason: run.failureReason },
      });
      continue;
    }
    for (const item of run.items) {
      const detail = {
        ...where,
        itemId: item.id,
        kind: item.kind,
        chargeId: item.chargeId,
        topupId: item.topupId,
        action: item.action,
        caseStatus: item.caseStatus,
      };
      if (item.kind === 'LEDGER_UNBALANCED' || item.kind === 'BALANCE_MISMATCH') {
        if (item.caseStatus === 'OPEN') {
          violations.push({
            invariant: 'INV-5',
            code: `${item.kind}_OPEN`,
            message: `tenant ${run.tenant}: đối soát ngày ${run.day} báo ${item.kind} chưa xử lý (item ${item.id}): ${JSON.stringify(item.detail)}`,
            detail: { ...detail, itemDetail: item.detail },
          });
        }
      } else if (item.kind === 'MISSING_AT_WALLET') {
        if (item.action === 'AUTO_APPLIED' && item.caseStatus !== 'OPEN') {
          autoApplied.add(`${run.tenant}/${String(item.chargeId)}`);
        } else {
          violations.push({
            invariant: 'INV-5',
            code: 'MISSING_AT_WALLET_UNFIXED',
            message: `tenant ${run.tenant}: charge ${item.chargeId} (topup ${item.topupId}) thiếu ở wallet nhưng đối soát ngày ${run.day} chưa ghi bù (action ${item.action}, ${item.caseStatus})`,
            detail,
          });
        }
      } else if (item.caseStatus === 'OPEN') {
        violations.push({
          invariant: 'INV-5',
          code: 'RECONCILIATION_ITEM_OPEN',
          message: `tenant ${run.tenant}: đối soát ngày ${run.day} còn item ${item.kind} chưa xử lý (item ${item.id}, charge ${item.chargeId}, topup ${item.topupId})`,
          detail: { ...detail, itemDetail: item.detail },
        });
      }
    }
  }
  return { runs: [...runs], violations, autoApplied };
}

/**
 * INV-5: không còn sai lệch sổ cái chưa xử lý, mọi khoản MISSING_AT_WALLET đều đã được ghi bù ĐÚNG tập mà INV-3 đã giải thích
 * (`remembered`), và lượt đối soát thứ hai không còn phát hiện gì (hội tụ). Lượt thứ hai chỉ chạy khi lượt đầu sạch.
 */
async function checkInv5(
  system: System,
  tenants: Tenant[],
  ctx: { extraDays: readonly string[]; runner: ReconcileRunner; remembered: ReadonlySet<string> },
): Promise<Violation[]> {
  const first = await reconcileAll(system, tenants, ctx.extraDays, ctx.runner, 1);
  const judged = judgeFirstPass(first.runs);
  const out = judged.violations;

  const unfixed = new Set(
    out
      .filter((v) => v.code === 'MISSING_AT_WALLET_UNFIXED')
      .map((v) => `${String(v.detail?.tenant)}/${String(v.detail?.chargeId)}`),
  );
  const unexpected = [...judged.autoApplied].filter((key) => !ctx.remembered.has(key));
  if (unexpected.length > 0) {
    out.push({
      invariant: 'INV-5',
      code: 'AUTOFIX_UNEXPECTED',
      message: `đối soát đã ghi bù charge mà INV-3 không hề báo thiếu: ${listIds(unexpected)}`,
      detail: { charges: unexpected },
    });
  }
  const absent = [...ctx.remembered].filter(
    (key) => !judged.autoApplied.has(key) && !unfixed.has(key),
  );
  if (absent.length > 0) {
    out.push({
      invariant: 'INV-5',
      code: 'AUTOFIX_MISSING',
      message: `charge thiếu ở wallet (INV-3) nhưng đối soát không ghi bù: ${listIds(absent)}`,
      detail: { charges: absent },
    });
  }
  if (out.length > 0) return out;

  // Hội tụ: sau lượt đầu (và việc ghi bù), một lượt nữa trên cùng dữ liệu (ngày suy ra lại: ghi bù có thể sang ngày mới) phải trống.
  const second = await reconcileAll(system, tenants, ctx.extraDays, ctx.runner, 2);
  for (const run of second.runs) {
    if (run.status === 'COMPLETED' && run.items.length === 0) continue;
    out.push({
      invariant: 'INV-5',
      code: 'RECONCILIATION_NOT_CONVERGED',
      message: `tenant ${run.tenant}: lượt đối soát thứ hai ngày ${run.day} (${run.runId}) ${
        run.status === 'COMPLETED'
          ? `vẫn phát hiện ${run.items.length} sai lệch: ${listIds(run.items.map((i) => `${i.kind} (charge ${i.chargeId}, topup ${i.topupId})`))}`
          : `kết thúc ${run.status}: ${run.failureReason ?? 'không rõ lý do'}`
      }`,
      detail: {
        tenant: run.tenant,
        day: run.day,
        runId: run.runId,
        status: run.status,
        kinds: run.items.map((i) => i.kind),
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-6: thao tác vận hành (ops) nguyên tử: mỗi dòng ops_actions đều có hiệu ứng và ngược lại
// ---------------------------------------------------------------------------------------------------------------------

interface OpsActionRow {
  seq: string;
  id: string;
  action: string;
  target: string;
  idempotency_key: string;
  result: string;
}

async function checkInv6(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  for (const tenant of tenants) {
    const actions = await rows(
      system.walletAdmin,
      sql<OpsActionRow>`
        select seq, id, action, target, idempotency_key, result from ${table(tenant, 'ops_actions')} order by seq`,
    );
    const txs = await rows(
      system.walletAdmin,
      sql<{
        id: string;
        business_key: string;
        kind: string;
        reverses_transaction_id: string | null;
      }>`
        select id, business_key, kind, reverses_transaction_id from ${table(tenant, 'ledger_transactions')}
        where kind in ('ADJUSTMENT', 'REVERSAL')`,
    );
    const touched = await rows(
      system.walletAdmin,
      sql<{ transaction_id: string; account_id: string }>`
        select e.transaction_id, e.account_id from ${table(tenant, 'ledger_entries')} e
        join ${table(tenant, 'ledger_transactions')} x on x.id = e.transaction_id
        where x.kind = 'ADJUSTMENT'`,
    );
    const wallets = await rows(
      system.walletAdmin,
      sql<{ id: string; frozen_at: Date | null }>`
        select id, frozen_at from ${table(tenant, 'accounts')} where kind = 'WALLET'`,
    );
    const base = { tenant: tenant.name };

    // (a) khóa idempotency (và id) không trùng ở mức dữ liệu (ràng buộc unique có thể bị tháo nhầm).
    for (const [field, label] of [
      ['idempotency_key', 'khóa idempotency'],
      ['id', 'id'],
    ] as const) {
      const seen = new Map<string, string[]>();
      for (const a of actions) seen.set(a[field], [...(seen.get(a[field]) ?? []), a.id]);
      const dup = [...seen].filter(([, ids]) => ids.length > 1);
      if (dup.length > 0) {
        out.push({
          invariant: 'INV-6',
          code: field === 'id' ? 'OPS_DUPLICATE_ID' : 'OPS_DUPLICATE_KEY',
          message: `tenant ${tenant.name}: nhiều dòng ops_actions cùng ${label}: ${listIds(dup.map(([k, ids]) => `${k} ← ${ids.join(' & ')}`))}`,
          detail: { ...base, values: dup.map(([k]) => k) },
        });
      }
    }

    const adjustTxByKey = new Map(
      txs.filter((x) => x.kind === 'ADJUSTMENT').map((x) => [x.business_key, x]),
    );
    const reversalByTarget = new Map(
      txs
        .filter((x) => x.kind === 'REVERSAL' && x.reverses_transaction_id !== null)
        .map((x) => [x.reverses_transaction_id as string, x]),
    );
    const accountsOf = new Map<string, Set<string>>();
    for (const e of touched) {
      accountsOf.set(
        e.transaction_id,
        (accountsOf.get(e.transaction_id) ?? new Set()).add(e.account_id),
      );
    }
    const parsedTransactionId = (action: OpsActionRow): string | undefined => {
      try {
        const id = (JSON.parse(action.result) as { transactionId?: unknown }).transactionId;
        return typeof id === 'string' ? id : undefined;
      } catch {
        return undefined;
      }
    };

    const adjustKeys = new Set<string>();
    const reverseTargets = new Map<string, string[]>();
    const lastFreeze = new Map<string, OpsActionRow>(); // wallet:<customer> → hành động FREEZE/UNFREEZE cuối (theo seq)
    for (const action of actions) {
      if (action.action === 'ADJUST') {
        adjustKeys.add(`adjustment:${action.id}`);
        const tx = adjustTxByKey.get(`adjustment:${action.id}`);
        if (tx === undefined) {
          out.push({
            invariant: 'INV-6',
            code: 'ADJUST_TX_MISSING',
            message: `tenant ${tenant.name}: ops ADJUST ${action.id} (${action.target}) không có giao dịch ADJUSTMENT adjustment:${action.id}`,
            detail: { ...base, actionId: action.id, target: action.target },
          });
          continue;
        }
        const walletId = action.target;
        if (!accountsOf.get(tx.id)?.has(walletId)) {
          out.push({
            invariant: 'INV-6',
            code: 'ADJUST_TX_WRONG_WALLET',
            message: `tenant ${tenant.name}: ops ADJUST ${action.id} nhắm ${action.target} nhưng giao dịch ${tx.id} không có dòng nào của ví đó`,
            detail: { ...base, actionId: action.id, transactionId: tx.id, target: action.target },
          });
        }
        const recorded = parsedTransactionId(action);
        if (recorded !== undefined && recorded !== tx.id) {
          out.push({
            invariant: 'INV-6',
            code: 'ADJUST_TX_RESULT_MISMATCH',
            message: `tenant ${tenant.name}: ops ADJUST ${action.id} ghi kết quả giao dịch ${recorded} nhưng giao dịch thật là ${tx.id}`,
            detail: { ...base, actionId: action.id, recorded, transactionId: tx.id },
          });
        }
      } else if (action.action === 'REVERSE') {
        const target = action.target.replace(/^transaction:/, '');
        reverseTargets.set(target, [...(reverseTargets.get(target) ?? []), action.id]);
        const tx = reversalByTarget.get(target);
        if (tx === undefined) {
          out.push({
            invariant: 'INV-6',
            code: 'REVERSE_TX_MISSING',
            message: `tenant ${tenant.name}: ops REVERSE ${action.id} (${action.target}) không có giao dịch REVERSAL đảo giao dịch ${target}`,
            detail: { ...base, actionId: action.id, target },
          });
          continue;
        }
        const recorded = parsedTransactionId(action);
        if (recorded !== undefined && recorded !== tx.id) {
          out.push({
            invariant: 'INV-6',
            code: 'REVERSE_TX_RESULT_MISMATCH',
            message: `tenant ${tenant.name}: ops REVERSE ${action.id} ghi kết quả giao dịch ${recorded} nhưng giao dịch đảo thật là ${tx.id}`,
            detail: { ...base, actionId: action.id, recorded, transactionId: tx.id },
          });
        }
      } else if (action.action === 'FREEZE' || action.action === 'UNFREEZE') {
        lastFreeze.set(action.target, action);
      }
    }

    // (b) mỗi giao dịch đảo chỉ do đúng một thao tác REVERSE.
    const doubled = [...reverseTargets].filter(([, ids]) => ids.length > 1);
    if (doubled.length > 0) {
      out.push({
        invariant: 'INV-6',
        code: 'REVERSE_ACTION_DUPLICATE',
        message: `tenant ${tenant.name}: nhiều thao tác REVERSE cho cùng một giao dịch: ${listIds(doubled.map(([t, ids]) => `${t} ← ${ids.join(' & ')}`))}`,
        detail: { ...base, targets: doubled.map(([t]) => t) },
      });
    }

    // (c) đóng băng: frozen_at của từng ví khớp thao tác FREEZE/UNFREEZE cuối cùng (không có thao tác nào ⇒ không bị đóng băng).
    const badFreeze: string[] = [];
    for (const wallet of wallets) {
      const customer = wallet.id.replace(/^wallet:/, '');
      const last = lastFreeze.get(`wallet:${customer}`);
      const expectFrozen = last?.action === 'FREEZE';
      if ((wallet.frozen_at !== null) !== expectFrozen) {
        badFreeze.push(
          `${wallet.id} (frozen_at ${wallet.frozen_at === null ? 'null' : 'có'}, thao tác cuối ${last?.action ?? 'không có'})`,
        );
      }
    }
    if (badFreeze.length > 0) {
      out.push({
        invariant: 'INV-6',
        code: 'FREEZE_STATE_MISMATCH',
        message: `tenant ${tenant.name}: trạng thái đóng băng không khớp thao tác ops cuối cùng: ${listIds(badFreeze)}`,
        detail: { ...base, wallets: badFreeze },
      });
    }

    // (c') REPLAY_PAID: mỗi thao tác phải để lại đúng một dòng outbox OrderPaidV1 (correlation_id `ops-replay:<actionId>`)
    // cho đơn mục tiêu; ngược lại mọi dòng outbox `ops-replay:*` phải thuộc một thao tác REPLAY_PAID. Retention thật có thể
    // đã dọn dòng SENT nên khi đó bỏ qua chiều "thao tác ⇒ dòng outbox" (chiều ngược chỉ xét dòng còn lại).
    const replayRows = await rows(
      system.walletAdmin,
      sql<{ id: string; event_type: string; correlation_id: string; order_id: string | null }>`
        select id, event_type, correlation_id, json_value(payload, '$.orderId') as order_id
        from ${table(tenant, 'outbox')} where correlation_id like 'ops-replay:%'`,
    );
    const replayActions = new Map(
      actions.filter((a) => a.action === 'REPLAY_PAID').map((a) => [a.id, a]),
    );
    if (!system.retentionDeletes) {
      const missingReplay: string[] = [];
      const wrongReplay: string[] = [];
      for (const [id, action] of replayActions) {
        const row = replayRows.filter((r) => r.correlation_id === `ops-replay:${id}`);
        if (row.length === 0) missingReplay.push(`${id} (${action.target})`);
        else if (
          row.length > 1 ||
          row.some((r) => r.event_type !== 'OrderPaidV1' || `order:${r.order_id}` !== action.target)
        ) {
          wrongReplay.push(
            `${id} (${action.target} ↔ ${row.map((r) => `${r.event_type}/${r.order_id}`).join(', ')})`,
          );
        }
      }
      if (missingReplay.length > 0) {
        out.push({
          invariant: 'INV-6',
          code: 'REPLAY_OUTBOX_MISSING',
          message: `tenant ${tenant.name}: ops REPLAY_PAID không để lại dòng outbox OrderPaidV1 ops-replay:<id>: ${listIds(missingReplay)}`,
          detail: { ...base, actionIds: missingReplay },
        });
      }
      if (wrongReplay.length > 0) {
        out.push({
          invariant: 'INV-6',
          code: 'REPLAY_OUTBOX_MISMATCH',
          message: `tenant ${tenant.name}: dòng outbox của REPLAY_PAID sai loại/đơn hoặc trùng: ${listIds(wrongReplay)}`,
          detail: { ...base, actionIds: wrongReplay },
        });
      }
    }
    const orphanReplay = replayRows.filter(
      (r) => !replayActions.has(r.correlation_id.slice('ops-replay:'.length)),
    );
    if (orphanReplay.length > 0) {
      out.push({
        invariant: 'INV-6',
        code: 'REPLAY_OUTBOX_ORPHAN',
        message: `tenant ${tenant.name}: dòng outbox ops-replay không có thao tác REPLAY_PAID: ${listIds(orphanReplay.map((r) => `${r.id} (${r.correlation_id})`))}`,
        detail: { ...base, outboxIds: orphanReplay.map((r) => r.id) },
      });
    }
    // (d) hiệu ứng mồ côi: ADJUSTMENT/REVERSAL không thuộc thao tác ops nào.
    const orphanAdjust = txs.filter(
      (x) => x.kind === 'ADJUSTMENT' && !adjustKeys.has(x.business_key),
    );
    if (orphanAdjust.length > 0) {
      out.push({
        invariant: 'INV-6',
        code: 'ADJUSTMENT_TX_ORPHAN',
        message: `tenant ${tenant.name}: giao dịch ADJUSTMENT không có dòng ops_actions: ${listIds(orphanAdjust.map((x) => `${x.id} (${x.business_key})`))}`,
        detail: { ...base, transactionIds: orphanAdjust.map((x) => x.id) },
      });
    }
    const orphanReversal = txs.filter(
      (x) => x.kind === 'REVERSAL' && !reverseTargets.has(x.reverses_transaction_id ?? ''),
    );
    if (orphanReversal.length > 0) {
      out.push({
        invariant: 'INV-6',
        code: 'REVERSAL_TX_ORPHAN',
        message: `tenant ${tenant.name}: giao dịch REVERSAL không có dòng ops_actions REVERSE: ${listIds(orphanReversal.map((x) => `${x.id} (đảo ${x.reverses_transaction_id})`))}`,
        detail: { ...base, transactionIds: orphanReversal.map((x) => x.id) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-7: retention an toàn — mọi thứ client đã được xác nhận thành công vẫn còn nguyên
// ---------------------------------------------------------------------------------------------------------------------

function splitKey(key: string): { tenant: string; id: string } {
  const at = key.indexOf('/');
  return { tenant: key.slice(0, at), id: key.slice(at + 1) };
}

/**
 * Đối chiếu System.expectations (chỉ ghi khi client nhận thành công): đơn Orders đã nhận OrderPaidV1 còn order_payments,
 * lần nạp đã trả topupId còn dòng topups, thao tác ops đã trả actionId còn dòng ops_actions. Retention không được đụng tới
 * các bảng này; xóa nhầm (hoặc mất dữ liệu do lỗi) sẽ bị bắt ở đây. Kết quả không xác định (lỗi) không bao giờ bị đòi.
 */
async function checkInv7(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  const known = new Map(tenants.map((t) => [t.name, t]));
  const expectations = system.expectations;
  const groups = [
    {
      keys: [...expectations.ordersPaid],
      code: 'ACKED_ORDER_MISSING',
      label: 'đơn đã trả (Orders đã nhận OrderPaidV1) không còn order_payments',
      load: async (tenant: Tenant) =>
        (
          await rows(
            system.walletAdmin,
            sql<{ id: string }>`select order_id as id from ${table(tenant, 'order_payments')}`,
          )
        ).map((r) => r.id),
    },
    {
      keys: [...expectations.topupsCreated],
      code: 'ACKED_TOPUP_MISSING',
      label: 'lần nạp đã tạo (đã trả topupId) không còn dòng topups',
      load: async (tenant: Tenant) =>
        (
          await rows(
            system.walletAdmin,
            sql<{ id: string }>`select id from ${table(tenant, 'topups')}`,
          )
        ).map((r) => r.id),
    },
    {
      keys: [...expectations.opsActionIds],
      code: 'ACKED_OPS_ACTION_MISSING',
      label: 'thao tác ops đã xác nhận (đã trả actionId) không còn dòng ops_actions',
      load: async (tenant: Tenant) =>
        (
          await rows(
            system.walletAdmin,
            sql<{ id: string }>`select id from ${table(tenant, 'ops_actions')}`,
          )
        ).map((r) => r.id),
    },
  ];
  for (const group of groups) {
    const present = new Map<string, Set<string>>();
    const lost: string[] = [];
    for (const key of group.keys) {
      const { tenant, id } = splitKey(key);
      const schema = known.get(tenant);
      if (schema === undefined) {
        lost.push(key);
        continue;
      }
      if (!present.has(tenant)) present.set(tenant, new Set(await group.load(schema)));
      if (!(present.get(tenant) as Set<string>).has(id)) lost.push(key);
    }
    if (lost.length > 0) {
      out.push({
        invariant: 'INV-7',
        code: group.code,
        message: `${group.label}: ${listIds(lost)}`,
        detail: { keys: lost },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// INV-8: phục hồi — cả hai dịch vụ sống, đọc được qua pool của chính nó
// ---------------------------------------------------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 10_000;

async function probe(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    await response.arrayBuffer();
    return response.status === 200
      ? { ok: true }
      : { ok: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `GET /health` = 200 cho cả hai dịch vụ; một lần đọc nhẹ đi qua pool DB của từng dịch vụ (wallet: GET /ops/actions;
 * payment: GET /settlements của hôm qua) thành công trong 10 giây; không dịch vụ con nào còn chết (chế độ child).
 * Lỗi kết nối KHÔNG ném mà thành vi phạm (đó chính là điều INV-8 phát hiện).
 */
async function checkInv8(system: System, tenants: Tenant[]): Promise<Violation[]> {
  const out: Violation[] = [];
  const first = tenants[0];
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
  const checks: Array<{
    service: 'wallet' | 'payment';
    what: string;
    code: string;
    url: string;
    headers?: Record<string, string>;
  }> = [
    {
      service: 'wallet',
      what: 'GET /health',
      code: 'HEALTH_FAILED',
      url: `${system.walletUrl}/health`,
    },
    {
      service: 'payment',
      what: 'GET /health',
      code: 'HEALTH_FAILED',
      url: `${system.paymentUrl}/health`,
    },
    {
      service: 'wallet',
      what: 'đọc nhẹ qua pool (GET /ops/actions)',
      code: 'READ_FAILED',
      url: `${system.walletUrl}/ops/actions?limit=1`,
      headers: {
        'x-tenant-id': first?.name ?? '',
        'x-actor-id': 'chaos-oracle',
        'x-actor-role': 'OPS',
      },
    },
    {
      service: 'payment',
      what: 'đọc nhẹ qua pool (GET /settlements)',
      code: 'READ_FAILED',
      url: `${system.paymentUrl}/settlements?date=${yesterday}&limit=1`,
    },
  ];
  const results = await Promise.all(checks.map((check) => probe(check.url, check.headers)));
  checks.forEach((check, index) => {
    const result = results[index];
    if (result === undefined || result.ok) return;
    out.push({
      invariant: 'INV-8',
      code: check.code,
      message: `${check.service}: ${check.what} thất bại (${result.reason})`,
      detail: { service: check.service, reason: result.reason },
    });
  });
  const pids = (system as { pids?: () => { wallet?: number; payment?: number } }).pids;
  if (system.mode === 'child' && typeof pids === 'function') {
    const alive = pids.call(system);
    for (const service of ['wallet', 'payment'] as const) {
      const pid = alive[service];
      if (pid === undefined || !isProcessAlive(pid)) {
        out.push({
          invariant: 'INV-8',
          code: 'SERVICE_DOWN',
          message: `${service}: tiến trình con không còn chạy (pid ${pid ?? 'không có'})`,
          detail: { service, pid: pid ?? null },
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------------------

type Check = (system: System, tenants: Tenant[]) => Promise<Violation[]>;

/** Kiểm tra CHỈ ĐỌC. INV-5 không nằm ở đây vì nó ghi (đối soát có autofix): chỉ chạy được qua runInvariants/assertSystemInvariants. */
const CHECKS: Partial<Record<InvariantId, Check>> = {
  'INV-1': checkInv1,
  'INV-2': checkInv2,
  'INV-3': checkInv3,
  'INV-4': checkInv4,
  'INV-6': checkInv6,
  'INV-7': checkInv7,
  'INV-8': checkInv8,
};

const ALL: readonly InvariantId[] = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5',
  'INV-6',
  'INV-7',
  'INV-8',
];
const READ_ONLY: readonly InvariantId[] = ALL.filter((id) => id !== 'INV-5');

function select(
  only: readonly InvariantId[] | undefined,
  fallback: readonly InvariantId[],
): InvariantId[] {
  const wanted = only ?? fallback;
  for (const id of wanted) {
    if (!ALL.includes(id)) throw new Error(`bất biến ${String(id)} không tồn tại`);
  }
  return ALL.filter((id) => wanted.includes(id)); // luôn theo thứ tự chuẩn, bất kể thứ tự người gọi liệt kê
}

/**
 * Một lượt kiểm tra CHỈ ĐỌC các bất biến đã chọn (mặc định INV-1..4, 6, 7, 8; thứ tự chuẩn). Lỗi truy vấn được ném, không bao
 * giờ thành "đạt". Không chạy INV-5 (đối soát có ghi bù thay đổi trạng thái, cần thứ tự kiểm tra riêng): dùng runInvariants.
 */
export async function collectViolations(
  system: System,
  options: InvariantOptions = {},
): Promise<Violation[]> {
  const selected = select(options.only, READ_ONLY);
  if (selected.includes('INV-5')) {
    throw new Error(
      'INV-5 chạy đối soát có ghi bù nên không thu được bằng collectViolations; dùng runInvariants/assertSystemInvariants',
    );
  }
  const tenants = await discoverTenants(system);
  const out: Violation[] = [];
  for (const id of selected) {
    out.push(...(await (CHECKS[id] as Check)(system, tenants)));
  }
  return out;
}

const PRE_AND_POST: readonly InvariantId[] = ['INV-1', 'INV-2', 'INV-3', 'INV-4'];

/**
 * Toàn bộ oracle, theo THỨ TỰ bắt buộc vì đối soát có thể ghi bù (autofix) và che lỗi:
 *  1. INV-1, INV-2, INV-4 chặt (đối soát không bao giờ đụng tới đơn hàng hay outbox);
 *  2. INV-3 TRƯỚC đối soát: phải rỗng; riêng `expectMissingAtWallet` (webhook bị mất có chủ ý, S7) thì chỉ được phép còn
 *     đúng các trạng thái MISSING_AT_WALLET (explainedByMissingAtWallet), và tập charge đó được nhớ lại;
 *  3. INV-8 (cần wallet sống để đối soát);
 *  4. nếu các bước trên sạch: đối soát có autofix qua API, mọi tenant, mọi ngày UTC có dữ liệu (INV-5), rồi kiểm lại
 *     INV-1..4 CHẶT (không còn miễn trừ) để chứng minh ghi bù đúng một lần và sổ cái vẫn cân;
 *  5. INV-6, INV-7.
 * Có vi phạm ở bước 1-3 thì KHÔNG chạy đối soát (đừng để autofix đổi hiện trường hoặc che lỗi); INV-6/7/8 vẫn được kiểm.
 *
 * `only`: chỉ chạy các bất biến liệt kê (luôn theo thứ tự chuẩn trên, không theo thứ tự liệt kê). INV-5 đòi liệt kê đủ
 * INV-1..INV-4: chạy đối soát mà không kiểm INV-3 trước/INV-1,2,4 trước và sau là cách để đối soát che lỗi, nên bị từ chối.
 */
export async function runInvariants(
  system: System,
  options: InvariantOptions = {},
): Promise<Violation[]> {
  const selected = select(options.only, ALL);
  const has = (id: InvariantId): boolean => selected.includes(id);
  if (has('INV-5')) {
    const lacking = PRE_AND_POST.filter((id) => !has(id));
    if (lacking.length > 0) {
      throw new Error(
        `INV-5 (đối soát có ghi bù) đòi kiểm cả INV-1..INV-4 trước và sau đối soát; thiếu ${lacking.join(', ')}`,
      );
    }
  }
  if (options.expectMissingAtWallet === true && !has('INV-5')) {
    throw new Error(
      'expectMissingAtWallet chỉ có nghĩa khi INV-5 chạy trong cùng lần gọi (nếu không INV-3 sẽ được miễn mà không ai ghi bù); thêm INV-5 vào only hoặc bỏ cờ',
    );
  }
  const tenants = await discoverTenants(system);
  const strict: Violation[] = [];
  for (const id of ['INV-1', 'INV-2', 'INV-4'] as const) {
    if (has(id)) strict.push(...(await (CHECKS[id] as Check)(system, tenants)));
  }

  // Charge (tenant/chargeId) mà webhook bị mất có chủ ý: INV-3 cho phép đúng trạng thái này TRƯỚC đối soát.
  const remembered = new Set<string>();
  if (has('INV-3')) {
    const inv3 = await checkInv3(system, tenants);
    if (options.expectMissingAtWallet === true && explainedByMissingAtWallet(inv3)) {
      const missing = inv3.filter(isMissingAtWallet);
      // Chỉ tha khi webhook của charge đó THỰC SỰ không tới được wallet (FAILED hết lượt, hoặc chưa có sự kiện). Webhook đã
      // DELIVERED (wallet trả 2xx) mà topup vẫn chưa ghi có nghĩa là wallet nhận mà không xử lý: lỗi thật, không bao giờ được tha.
      const delivered = await deliveredWebhookCharges(
        system,
        missing.map((v) => String(v.detail?.chargeId)),
      );
      if (delivered.length > 0) {
        strict.push(...inv3, {
          invariant: 'INV-3',
          code: 'MISSING_AT_WALLET_WEBHOOK_DELIVERED',
          message: `webhook đã DELIVERED nhưng wallet chưa ghi có (không thể do mất webhook): charge ${listIds(delivered)}`,
          detail: { chargeIds: delivered },
        });
      } else {
        for (const v of missing) {
          remembered.add(`${String(v.detail?.tenant)}/${String(v.detail?.chargeId)}`);
        }
      }
    } else {
      strict.push(...inv3);
    }
  }
  const health = has('INV-8') ? await checkInv8(system, tenants) : [];

  const out: Violation[] = [...strict];
  if (has('INV-5') && strict.length === 0 && health.length === 0) {
    out.push(
      ...(await checkInv5(system, tenants, {
        extraDays: options.reconcileDays ?? [],
        runner: options.reconcileRunner ?? runReconciliationViaHttp,
        remembered,
      })),
    );
    // Sau đối soát mọi thứ phải chặt: ghi bù đúng một lần, sổ cái cân, đơn hàng và outbox không bị đụng tới.
    for (const id of PRE_AND_POST) {
      for (const v of await (CHECKS[id] as Check)(system, tenants)) {
        out.push({
          ...v,
          message: `(sau đối soát) ${v.message}`,
          detail: { ...v.detail, phase: 'after-reconciliation' },
        });
      }
    }
  }
  if (has('INV-6')) out.push(...(await checkInv6(system, tenants)));
  if (has('INV-7')) out.push(...(await checkInv7(system, tenants)));
  out.push(...health);
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

/** Các charge trong danh sách mà payment ghi nhận webhook đã DELIVERED (wallet đã trả 2xx). */
async function deliveredWebhookCharges(
  system: System,
  chargeIds: readonly string[],
): Promise<string[]> {
  if (chargeIds.length === 0) return [];
  const found = await rows(
    system.paymentAdmin,
    sql<{ charge_id: string }>`
      select distinct charge_id from webhook_events
      where status = 'DELIVERED' and charge_id in (${sql.join(chargeIds)})`,
  );
  return found.map((r) => r.charge_id);
}

/** Ném InvariantViolationError nêu từng vi phạm cùng id cụ thể (tenant, orderId, topupId, accountId…). */
export async function assertSystemInvariants(
  system: System,
  options: InvariantOptions = {},
): Promise<void> {
  const violations = await runInvariants(system, options);
  if (violations.length > 0) throw new InvariantViolationError(violations);
}
