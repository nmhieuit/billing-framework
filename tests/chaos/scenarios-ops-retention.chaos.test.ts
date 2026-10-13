import { join } from 'node:path';
import { waitFor } from '@billing/testing';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dumpFailedTask } from './support/failure-dump.js';
import { assertSystemInvariants, collectViolations } from './support/invariants.js';
import { killSessions } from './support/sql-faults.js';
import { adminQuery, createSystem, type System } from './support/system-harness.js';

/**
 * Kịch bản S11-S13: KILL giữa thao tác ops, retention THẬT bị cắt giữa lô, và KILL toàn bộ session khi hệ đang rảnh.
 *
 * S11 và S13 dùng chung một hệ (retention tắt); S12 dựng hệ riêng với retention thật (batchSize 5). Mỗi kịch bản dùng
 * khách riêng và `plan.clear()` ở beforeEach nên lỗi không rò sang kịch bản sau.
 */

const TENANT = 'acme';
const OUT_DIR = join(import.meta.dirname, '.out');

const rowsOf = async <R>(db: Kysely<unknown>, query: RawBuilder<R>): Promise<R[]> =>
  (await adminQuery(db, (d) => query.execute(d))).rows;

const countOf = async (db: Kysely<unknown>, query: RawBuilder<{ n: number }>): Promise<number> =>
  Number((await rowsOf(db, query))[0]?.n ?? 0);

const balanceOf = async (s: System, customer: string): Promise<number> =>
  Number(
    (
      await rowsOf(
        s.walletAdmin,
        sql<{ balance: string }>`
          select balance from t_acme.accounts where customer_id = ${customer} and kind = 'WALLET'`,
      )
    )[0]?.balance,
  );

/** Ghi seed, lý do thất bại và nhật ký thao tác khi test thất bại (tests/chaos/.out/ đã được gitignore), rồi heal best-effort. */
function dumpOnFailure(get: () => System | undefined): void {
  afterEach(async (ctx) => {
    await dumpFailedTask(ctx.task, get(), OUT_DIR);
  });
}

/** Mở ví và nạp tiền bình thường (chưa có lỗi), chờ hội tụ; heal() tắt plan nên bật lại để rule có hiệu lực. */
async function fundedWallet(s: System, customer: string, amount: number): Promise<void> {
  expect((await s.openWallet(TENANT, customer)).status).toBe(201);
  expect((await s.topup(TENANT, customer, amount, `fund-${customer}`)).status).toBe(202);
  await s.heal();
  expect(await balanceOf(s, customer)).toBe(amount);
  s.plan.enable();
}

const isWalletWrite =
  (verb: 'insert' | 'update', table: string) =>
  (info: Record<string, unknown>): boolean =>
    info.name === 'wallet' &&
    typeof info.sql === 'string' &&
    info.sql.startsWith(verb) &&
    info.sql.includes(table);

/** Câu `delete top (n) x from ...` của retention (SQL viết trong template literal nên bắt đầu bằng khoảng trắng/xuống dòng). */
const isWalletDeleteTop = (info: Record<string, unknown>): boolean =>
  info.name === 'wallet' && typeof info.sql === 'string' && /^\s*delete top/.test(info.sql);

describe('S11 and S13: ops actions and pool recovery (in-process)', () => {
  let system: System | undefined;
  const sys = (): System => {
    if (system === undefined) throw new Error('hệ thống chưa dựng xong');
    return system;
  };

  beforeAll(async () => {
    system = await createSystem({ tenants: [TENANT] });
  });
  beforeEach(() => {
    system?.plan.clear();
    system?.plan.enable();
  });
  dumpOnFailure(() => system);
  afterAll(async () => {
    await system?.stop();
  });

  type OpKind = 'adjust' | 'reverse' | 'freeze';
  type KillPoint = 'first-write' | 'ledger-entries' | 'ops-actions-insert' | 'after-commit';

  interface OpCase {
    /** Thao tác ops và các điểm KILL áp dụng cho nó (freeze không ghi sổ cái). */
    op: OpKind;
    point: KillPoint;
  }

  const CASES: OpCase[] = [
    { op: 'adjust', point: 'first-write' },
    { op: 'adjust', point: 'ledger-entries' },
    { op: 'adjust', point: 'ops-actions-insert' },
    { op: 'adjust', point: 'after-commit' },
    { op: 'reverse', point: 'first-write' },
    { op: 'reverse', point: 'ledger-entries' },
    { op: 'reverse', point: 'ops-actions-insert' },
    { op: 'reverse', point: 'after-commit' },
    { op: 'freeze', point: 'first-write' },
    { op: 'freeze', point: 'ops-actions-insert' },
    { op: 'freeze', point: 'after-commit' },
  ];

  let caseNo = 0;

  /** Gửi lại CÙNG yêu cầu (cùng idempotencyKey) cho tới khi nhận 2xx; tối đa 3 lần. Trả số lần thử đã dùng. */
  async function retrySameRequest(
    s: System,
    route: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown; attempts: number }> {
    let last: { status: number; body: unknown } = { status: 0, body: undefined };
    for (let attempts = 1; attempts <= 3; attempts += 1) {
      last = await s.ops(TENANT, route, body);
      if (last.status >= 200 && last.status < 300) return { ...last, attempts };
    }
    return { ...last, attempts: 3 };
  }

  it.each(CASES)(
    'S11: session killed during ops $op at $point, retried with the same idempotencyKey: exactly one effect, consistent result',
    async ({ op, point }) => {
      const s = sys();
      caseNo += 1;
      const customer = `s11-${caseNo}`;
      const key = `s11-key-${caseNo}`;
      await fundedWallet(s, customer, 100_000);

      let route: string;
      let body: Record<string, unknown>;
      let expectedStatus: number;
      // Số hiệu ứng thật của thao tác (tính trực tiếp trong DB), tách riêng với dòng kiểm toán ops_actions.
      let effects: () => Promise<number>;
      let balanceDelta = 0;
      const reason = 'chaos S11';
      if (op === 'adjust') {
        route = `/ops/wallets/${customer}/adjustments`;
        body = { reason, idempotencyKey: key, direction: 'CREDIT', amount: 7_000, currency: 'VND' };
        expectedStatus = 201;
        balanceDelta = 7_000;
        effects = () =>
          countOf(
            s.walletAdmin,
            sql<{ n: number }>`
              select count(distinct t.id) as n from t_acme.ledger_transactions t
              join t_acme.ledger_entries e on e.transaction_id = t.id
              join t_acme.accounts a on a.id = e.account_id
              where t.kind = 'ADJUSTMENT' and a.customer_id = ${customer} and a.kind = 'WALLET'`,
          );
      } else if (op === 'reverse') {
        // Giao dịch ADJUSTMENT +5000 (không lỗi) làm đích để đảo: ví 105.000 → sau đảo 100.000.
        const seeded = await s.ops(TENANT, `/ops/wallets/${customer}/adjustments`, {
          reason,
          idempotencyKey: `${key}-seed`,
          direction: 'CREDIT',
          amount: 5_000,
          currency: 'VND',
        });
        expect(seeded.status).toBe(201);
        const target = (seeded.body as { transactionId: string }).transactionId;
        route = `/ops/transactions/${target}/reversals`;
        body = { reason, idempotencyKey: key };
        expectedStatus = 201;
        balanceDelta = -5_000;
        effects = () =>
          countOf(
            s.walletAdmin,
            sql<{
              n: number;
            }>`select count(*) as n from t_acme.ledger_transactions where reverses_transaction_id = ${target}`,
          );
      } else {
        route = `/ops/wallets/${customer}/freeze`;
        body = { reason, idempotencyKey: key };
        expectedStatus = 200;
        effects = () =>
          countOf(
            s.walletAdmin,
            sql<{
              n: number;
            }>`select count(*) as n from t_acme.accounts where customer_id = ${customer} and kind = 'WALLET' and frozen_at is not null`,
          );
      }
      const keyActions = () =>
        countOf(
          s.walletAdmin,
          sql<{
            n: number;
          }>`select count(*) as n from t_acme.ops_actions where idempotency_key = ${key}`,
        );
      const before = await balanceOf(s, customer);
      expect(await effects()).toBe(0);

      // Điểm KILL: câu lệnh GHI tương ứng của transaction ops. `nth: 1` vì khách và khóa riêng của ca này.
      let killed = false;
      const kill = async (): Promise<void> => {
        killed = true;
        await killSessions(s.walletDb);
      };
      if (point === 'after-commit') {
        // Mô phỏng phản hồi mất SAU commit: gắn lỗi vào đúng kết nối của transaction ghi ops_actions (worker nền cũng commit).
        let armed: unknown;
        s.plan.add({
          point: 'sql.query.after',
          label: 's11-arm',
          when: isWalletWrite('insert', 'ops_actions'),
          action: (info) => {
            armed = info.connection;
          },
        });
        s.plan.add({
          point: 'sql.commit.after',
          times: 1,
          label: 's11-kill',
          when: (info) =>
            info.name === 'wallet' && armed !== undefined && info.connection === armed,
          action: async () => {
            await kill();
            throw new Error('KILL sau commit, trước khi trả phản hồi');
          },
        });
      } else {
        const matcher =
          point === 'first-write'
            ? isWalletWrite('update', 'accounts')
            : point === 'ledger-entries'
              ? isWalletWrite('insert', 'ledger_entries')
              : isWalletWrite('insert', 'ops_actions');
        s.plan.add({
          point: 'sql.query.before',
          nth: 1,
          label: 's11-kill',
          when: matcher,
          action: kill,
        });
      }

      const first = await s.ops(TENANT, route, body);
      expect(killed).toBe(true);
      expect(s.plan.fired('s11-kill')).toBe(1);
      // Phản hồi lần đầu là lỗi (kết nối chết giữa chừng hoặc mất phản hồi): client không biết kết quả.
      expect(first.status).toBeGreaterThanOrEqual(500);
      s.plan.clear(); // gỡ lỗi trước khi thử lại

      const committed = point === 'after-commit';
      // Trạng thái ngay sau lần đầu: hoặc commit trọn vẹn (một hiệu ứng + một dòng kiểm toán) hoặc rollback sạch (không gì cả).
      expect(await effects()).toBe(committed ? 1 : 0);
      expect(await keyActions()).toBe(committed ? 1 : 0);
      expect(await balanceOf(s, customer)).toBe(before + (committed ? balanceDelta : 0));
      const storedBefore = await rowsOf(
        s.walletAdmin,
        sql<{ id: string; result: string }>`
          select id, result from t_acme.ops_actions where idempotency_key = ${key}`,
      );

      const retry = await retrySameRequest(s, route, body);
      s.log.record('s11.retry', { op, point, attempts: retry.attempts, status: retry.status });
      console.info(
        `[S11] ${op}/${point}: lần đầu ${first.status}, gửi lại cùng khóa: ${retry.status} sau ${retry.attempts} lần`,
      );
      expect(retry.status).toBe(expectedStatus);
      // Sau lỗi, pool có thể còn session chết: cho phép tối đa MỘT lần thử lại phía client ngoài lần gửi lại chính.
      expect(retry.attempts).toBeLessThanOrEqual(2);

      // Đúng MỘT hiệu ứng và MỘT dòng kiểm toán, dù lần đầu đã commit hay rollback.
      expect(await effects()).toBe(1);
      expect(await keyActions()).toBe(1);
      expect(await balanceOf(s, customer)).toBe(before + balanceDelta);
      const stored = await rowsOf(
        s.walletAdmin,
        sql<{ id: string; result: string }>`
          select id, result from t_acme.ops_actions where idempotency_key = ${key}`,
      );
      expect(stored).toHaveLength(1);
      // Kết quả trả về phải CHÍNH LÀ kết quả đã lưu (lần đầu đã commit: phát lại nguyên văn; rollback: kết quả của lần thực hiện mới).
      expect(retry.body).toEqual(JSON.parse(stored[0]?.result as string));
      expect((retry.body as { actionId: string }).actionId).toBe(stored[0]?.id);
      if (committed) {
        expect(stored[0]).toEqual(storedBefore[0]); // không có dòng kiểm toán mới, kết quả không đổi
      }

      // Gửi lần nữa: luôn là phát lại, không thêm hiệu ứng.
      const again = await s.ops(TENANT, route, body);
      expect(again.status).toBe(expectedStatus);
      expect(again.body).toEqual(retry.body);
      expect(await effects()).toBe(1);
      expect(await keyActions()).toBe(1);

      await s.heal();
      // Đọc thuần (không đối soát): sổ cái cân, ops nguyên tử (INV-6), thao tác đã xác nhận còn đó (INV-7).
      expect(await collectViolations(s, { only: ['INV-1', 'INV-6', 'INV-7'] })).toEqual([]);
    },
    120_000,
  );

  it('S11: oracle after all ops cases (INV-1..8 including a real reconciliation)', async () => {
    const s = sys();
    await s.heal();
    await assertSystemInvariants(s);
  });

  it('S13: all sessions killed while idle: the next request to each service succeeds with exactly one attempt (no client retry needed)', async () => {
    const s = sys();
    const customer = 's13';
    await fundedWallet(s, customer, 100_000);
    await s.heal();
    const get = async (): Promise<number> =>
      (
        await fetch(`${s.walletUrl}/wallet`, {
          headers: { 'x-tenant-id': TENANT, 'x-customer-id': customer },
        })
      ).status;

    // Hệ đang rảnh: giết MỌI session của wallet và payment.
    const killedWallet = await killSessions(s.walletDb);
    const killedPayment = await killSessions(s.paymentDb);
    s.log.record('s13.killed', { killedWallet, killedPayment });
    expect(killedWallet).toBeGreaterThan(0);
    expect(killedPayment).toBeGreaterThan(0);

    // Wallet đọc ví: thử lại tối đa một lần.
    const readAttempts: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const status = await get();
      readAttempts.push(status);
      if (status === 200) break;
    }
    s.log.record('s13.wallet-read', { statuses: readAttempts });
    console.info(`[S13] đọc ví sau khi giết mọi session: ${readAttempts.join(' -> ')}`);
    expect(readAttempts.at(-1)).toBe(200);
    expect(readAttempts).toEqual([200]); // đúng MỘT lần: pool kiểm tra kết nối khi lấy nên session chết được thay thầm lặng

    // Nạp tiền qua wallet → payment (đường tạo charge dùng pool payment vừa bị giết sạch).
    const topupStatuses: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await s.topup(TENANT, customer, 20_000, 's13-topup');
      topupStatuses.push(result.status);
      if (result.status === 202) break;
    }
    s.log.record('s13.topup', { statuses: topupStatuses });
    console.info(`[S13] nạp tiền sau khi giết mọi session: ${topupStatuses.join(' -> ')}`);
    expect(topupStatuses.at(-1)).toBe(202);
    expect(topupStatuses).toEqual([202]);

    // Một đơn qua consumer + outbox (consumer dùng pool đã bị giết).
    const order = await s.sendOrder({ tenant: TENANT, customer, amount: 10_000 });
    await s.heal(); // chờ topup và đơn hội tụ: pool phải tự hồi phục không cần khởi động lại
    expect(await balanceOf(s, customer)).toBe(100_000 + 20_000 - 10_000);
    expect(
      s.orders.received().filter((r) => r.payload.orderId === order.orderId).length,
    ).toBeGreaterThanOrEqual(1);
    // Cùng khóa idempotency gửi lại sau khi pool hồi phục: vẫn là MỘT lần nạp.
    const topups = await countOf(
      s.walletAdmin,
      sql<{
        n: number;
      }>`select count(*) as n from t_acme.topups where customer_id = ${customer} and amount = 20000`,
    );
    expect(topups).toBe(1);
    expect(await collectViolations(s, { only: ['INV-8'] })).toEqual([]);
    await assertSystemInvariants(s);
  });
});

describe('S12: real retention cut in the middle of a batch (in-process)', () => {
  let system: System | undefined;
  const sys = (): System => {
    if (system === undefined) throw new Error('hệ thống chưa dựng xong');
    return system;
  };

  beforeAll(async () => {
    // intervalMinutes lớn: Worker retention chạy ĐÚNG MỘT lượt lúc khởi động mỗi lần restartWallet()/restartPayment(), nên kịch bản
    // quyết định tất định lúc nào có lượt dọn (không đua với đồng hồ). Không có gì đủ cũ lúc khởi động đầu tiên nên lượt đó rỗng.
    system = await createSystem({
      tenants: [TENANT],
      retention: {
        dryRun: false,
        batchSize: 5,
        intervalMinutes: 60,
        days: {
          wallet: { outboxSent: 1, processedMessages: 1, idempotencyKeys: 1, reconciliation: 1 },
          payment: { webhook: 1, idempotencyKeys: 1 },
        },
      },
    });
  });
  dumpOnFailure(() => system);
  afterAll(async () => {
    await system?.stop();
  });

  const AGED = sql`dateadd(day, -3, sysutcdatetime())`;
  const CUTOFF = sql`dateadd(day, -1, sysutcdatetime())`;

  /** Đếm dòng "đủ tuổi dọn" (eligible) và dòng "còn trẻ" (young) của từng bảng retention bên wallet / payment. */
  async function census(s: System) {
    const wallet = (query: RawBuilder<{ n: number }>) => countOf(s.walletAdmin, query);
    const payment = (query: RawBuilder<{ n: number }>) => countOf(s.paymentAdmin, query);
    return {
      outboxEligible: await wallet(
        sql<{
          n: number;
        }>`select count(*) as n from t_acme.outbox where status = 'SENT' and sent_at < ${CUTOFF}`,
      ),
      outboxYoung: await wallet(
        sql<{
          n: number;
        }>`select count(*) as n from t_acme.outbox where not (status = 'SENT' and sent_at < ${CUTOFF})`,
      ),
      inboxEligible: await wallet(
        sql<{
          n: number;
        }>`select count(*) as n from t_acme.processed_messages where processed_at < ${CUTOFF}`,
      ),
      inboxYoung: await wallet(
        sql<{
          n: number;
        }>`select count(*) as n from t_acme.processed_messages where processed_at >= ${CUTOFF}`,
      ),
      keysEligible: await wallet(
        sql<{
          n: number;
        }>`select count(*) as n from t_acme.idempotency_keys where created_at < ${CUTOFF}`,
      ),
      keysYoung: await wallet(
        sql<{
          n: number;
        }>`select count(*) as n from t_acme.idempotency_keys where created_at >= ${CUTOFF}`,
      ),
      payKeysEligible: await payment(
        sql<{
          n: number;
        }>`select count(*) as n from idempotency_keys where created_at < ${CUTOFF}`,
      ),
      payKeysYoung: await payment(
        sql<{
          n: number;
        }>`select count(*) as n from idempotency_keys where created_at >= ${CUTOFF}`,
      ),
      hooksEligible: await payment(
        sql<{
          n: number;
        }>`select count(*) as n from webhook_events where status = 'DELIVERED' and delivered_at < ${CUTOFF}`,
      ),
      hooksYoung: await payment(
        sql<{
          n: number;
        }>`select count(*) as n from webhook_events where not (status = 'DELIVERED' and delivered_at < ${CUTOFF})`,
      ),
    };
  }

  /** Mọi bảng tài chính (không bao giờ được retention đụng tới) ở dạng so sánh được. */
  async function financial(s: System) {
    const w = (table: string) =>
      countOf(
        s.walletAdmin,
        sql<{ n: number }>`select count(*) as n from ${sql.id('t_acme', table)}`,
      );
    return {
      accounts: await w('accounts'),
      ledgerTransactions: await w('ledger_transactions'),
      ledgerEntries: await w('ledger_entries'),
      topups: await w('topups'),
      orderPayments: await w('order_payments'),
      balances: await rowsOf(
        s.walletAdmin,
        sql<{ id: string; balance: string }>`select id, balance from t_acme.accounts order by id`,
      ),
      charges: await countOf(s.paymentAdmin, sql<{ n: number }>`select count(*) as n from charges`),
    };
  }

  it('S12: real retention killed on the 2nd delete batch deletes no live row; the next pass finishes the purge', async () => {
    const s = sys();
    expect(s.retentionDeletes).toBe(true);
    const customer = 's12';
    expect((await s.openWallet(TENANT, customer)).status).toBe(201);
    // Hoạt động thật: 12 lần nạp (khóa idempotency, webhook, inbox) và 12 đơn (inbox, outbox OrderPaidV1 SENT).
    for (let i = 0; i < 12; i += 1) {
      expect((await s.topup(TENANT, customer, 10_000, `s12-old-${i}`)).status).toBe(202);
    }
    await s.heal();
    for (let i = 0; i < 12; i += 1) {
      await s.sendOrder({ tenant: TENANT, customer, amount: 100 });
    }
    await s.heal();

    // Làm "già" mọi dòng hiện có (3 ngày > 1 ngày retention) bằng kết nối quản trị: chỉ cột thời gian đổi, không đụng tiền.
    await rowsOf(
      s.walletAdmin,
      sql`update t_acme.outbox set sent_at = ${AGED}, created_at = ${AGED} where status = 'SENT'`,
    );
    await rowsOf(s.walletAdmin, sql`update t_acme.processed_messages set processed_at = ${AGED}`);
    await rowsOf(s.walletAdmin, sql`update t_acme.idempotency_keys set created_at = ${AGED}`);
    await rowsOf(s.paymentAdmin, sql`update idempotency_keys set created_at = ${AGED}`);
    await rowsOf(
      s.paymentAdmin,
      sql`update webhook_events set delivered_at = ${AGED} where status = 'DELIVERED'`,
    );
    // Dòng "còn trẻ": thêm hoạt động mới SAU khi làm già. Chúng phải sống sót mọi lượt dọn.
    for (let i = 0; i < 2; i += 1) {
      expect((await s.topup(TENANT, customer, 1_000, `s12-young-${i}`)).status).toBe(202);
    }
    await s.heal();
    for (let i = 0; i < 3; i += 1) {
      await s.sendOrder({ tenant: TENANT, customer, amount: 100 });
    }
    await s.heal();

    const before = await census(s);
    const financialBefore = await financial(s);
    // Đủ nhiều lô: batchSize 5 → outbox/inbox đều cần >= 3 lô; có dòng trẻ để chứng minh dọn không quá tay.
    expect(before.outboxEligible).toBeGreaterThanOrEqual(11);
    expect(before.inboxEligible).toBeGreaterThanOrEqual(11);
    expect(before.keysEligible).toBeGreaterThanOrEqual(11);
    expect(before.payKeysEligible).toBeGreaterThanOrEqual(11);
    expect(before.hooksEligible).toBeGreaterThanOrEqual(11);
    expect(before.outboxYoung).toBeGreaterThan(0);
    expect(before.inboxYoung).toBeGreaterThan(0);
    expect(before.keysYoung).toBeGreaterThan(0);
    expect(before.hooksYoung).toBeGreaterThan(0);

    // KILL ở lệnh `delete top` THỨ HAI của chính sách outbox_sent: lô 1 đã commit (xóa 5), lô 2 chết trước khi chạy.
    s.plan.clear();
    s.plan.enable();
    s.plan.add({
      point: 'sql.query.before',
      nth: 2,
      label: 's12-kill',
      when: (info) => isWalletDeleteTop(info) && String(info.sql).includes('outbox'),
      action: async () => {
        await killSessions(s.walletDb);
      },
    });
    s.plan.add({
      point: 'sql.query.before',
      label: 's12-deletes',
      when: isWalletDeleteTop,
      action: () => undefined,
    });
    // Restart wallet = Worker retention mới → một lượt dọn ngay khi khởi động.
    await s.restartWallet();
    await waitFor(() => s.plan.fired('s12-kill') === 1, { timeoutMs: 60_000, intervalMs: 50 });

    // Lưu ý: sau khi lô 2 của outbox_sent bị giết, lượt dọn vẫn chạy tiếp các chính sách sau (processed_messages, idempotency_keys)
    // nên KHÔNG khẳng định gì về inbox/khóa idempotency tại điểm cắt, chỉ về outbox và các dòng trẻ.
    // Lượt bị cắt: đúng lô 1 của outbox đã xóa (5 dòng), phần còn lại của outbox đủ tuổi còn nguyên; dòng trẻ không mất.
    const cut = await census(s);
    expect(cut.outboxEligible).toBe(before.outboxEligible - 5);
    expect(cut.outboxYoung).toBe(before.outboxYoung);
    expect(cut.inboxYoung).toBe(before.inboxYoung);
    expect(cut.keysYoung).toBe(before.keysYoung);
    // Bảng tài chính (và số dư) y nguyên; oracle đọc thuần đạt ngay sau lỗi (retention thật ⇒ oracle chỉ nhìn dòng còn lại).
    expect(await financial(s)).toEqual(financialBefore);
    s.plan.disable(); // oracle/heal không bị lỗi mới
    expect(
      await collectViolations(s, { only: ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-6', 'INV-7'] }),
    ).toEqual([]);

    // Lượt dọn kế tiếp (khởi động lại) hoàn tất phần còn lại, bỏ qua dòng trẻ.
    s.plan.clear();
    s.plan.enable();
    await s.restartWallet();
    await waitFor(
      async () => {
        const c = await census(s);
        return c.outboxEligible === 0 && c.inboxEligible === 0 && c.keysEligible === 0;
      },
      { timeoutMs: 60_000, intervalMs: 100 },
    );
    const afterWallet = await census(s);
    expect(afterWallet.outboxYoung).toBe(before.outboxYoung);
    expect(afterWallet.inboxYoung).toBe(before.inboxYoung);
    expect(afterWallet.keysYoung).toBe(before.keysYoung);
    // Dọn THẬT (không phải chạy thử): số dòng đã biến mất > 0 và đúng bằng số dòng từng đủ tuổi.
    const outboxTotal = await countOf(
      s.walletAdmin,
      sql<{ n: number }>`select count(*) as n from t_acme.outbox`,
    );
    expect(outboxTotal).toBe(before.outboxYoung);

    // Phía payment: lượt dọn bằng restart (không lỗi) xóa khóa idempotency và webhook DELIVERED đã già, giữ dòng trẻ.
    await s.restartPayment();
    await waitFor(
      async () => {
        const c = await census(s);
        return c.payKeysEligible === 0 && c.hooksEligible === 0;
      },
      { timeoutMs: 60_000, intervalMs: 100 },
    );
    const afterPayment = await census(s);
    expect(afterPayment.payKeysYoung).toBe(before.payKeysYoung);
    expect(afterPayment.hooksYoung).toBe(before.hooksYoung);
    // Mọi bảng tài chính vẫn y nguyên sau cả hai lượt dọn.
    expect(await financial(s)).toEqual(financialBefore);

    await s.heal();
    await assertSystemInvariants(s);
  }, 240_000);
});
