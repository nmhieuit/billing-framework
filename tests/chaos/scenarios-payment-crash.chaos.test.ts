import { join } from 'node:path';
import { signWebhook } from '@billing/contracts';
import { waitFor } from '@billing/testing';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSystemInvariants,
  reconcileDaysOf,
  runReconciliationViaHttp,
} from './support/invariants.js';
import { SECRET } from './support/service-config.js';
import {
  adminQuery,
  createSystem,
  type ChildSystem,
  type System,
} from './support/system-harness.js';

/**
 * Kịch bản S6-S10: payment lỗi/timeout khi tạo charge, webhook thất lạc/trùng/muộn, và crash thật (SIGKILL) hai dịch vụ.
 *
 * S6-S8 chạy trong tiến trình test (mode 'inproc'), một hệ dùng chung cả nhóm; S9-S10 chạy hai tiến trình con thật (mode
 * 'child'). Mỗi kịch bản dùng khách riêng và `plan.clear()` ở beforeEach nên lỗi không rò sang kịch bản sau.
 * Cấu hình harness: payment timeout của wallet = 3000ms; backoff nạp tiền và webhook = [1, 2, 3] giây (hết lượt sau 3 lần
 * thử lại, tức 4 lần gửi).
 */

const TENANT = 'acme';
const OUT_DIR = join(import.meta.dirname, '.out');
// Phải khớp timeout 3000ms mặc định của wallet trong service-config.ts; test S6 kiểm gián tiếp (attempts của topup).
const PAYMENT_TIMEOUT_MS = 3000;

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
          select balance from t_acme.accounts where customer_id = ${customer}`,
      )
    )[0]?.balance,
  );

interface TopupRow {
  id: string;
  status: string;
  charge_id: string | null;
  attempts: number;
}

/** Topup duy nhất của khách (mỗi kịch bản đúng một lần nạp). */
async function topupOf(s: System, customer: string): Promise<TopupRow> {
  const rows = await rowsOf(
    s.walletAdmin,
    sql<TopupRow>`
      select id, status, charge_id, attempts from t_acme.topups where customer_id = ${customer}`,
  );
  expect(rows).toHaveLength(1);
  return rows[0] as TopupRow;
}

const chargesOf = (s: System, topupId: string) =>
  rowsOf(
    s.paymentAdmin,
    sql<{
      id: string;
      status: string;
    }>`select id, status from charges where reference = ${topupId}`,
  );

const totalCharges = (s: System): Promise<number> =>
  countOf(s.paymentAdmin, sql<{ n: number }>`select count(*) as n from charges`);

const idempotencyKeyRows = (s: System, topupId: string): Promise<number> =>
  countOf(
    s.paymentAdmin,
    sql<{
      n: number;
    }>`select count(*) as n from idempotency_keys where idempotency_key = ${`topup:${TENANT}:${topupId}`}`,
  );

/** Số giao dịch sổ cái TOPUP của một lần nạp (business key `topup:<id>`): phải là đúng 1 khi đã ghi có. */
const topupLedgerTransactions = (s: System, topupId: string): Promise<number> =>
  countOf(
    s.walletAdmin,
    sql<{
      n: number;
    }>`select count(*) as n from t_acme.ledger_transactions where kind = 'TOPUP' and business_key = ${`topup:${topupId}`}`,
  );

interface WebhookRow {
  status: string;
  attempts: number;
}

const webhookOf = async (s: System, topupId: string): Promise<WebhookRow | undefined> =>
  (
    await rowsOf(
      s.paymentAdmin,
      sql<WebhookRow>`
        select w.status, w.attempts from webhook_events w
        join charges c on c.id = w.charge_id where c.reference = ${topupId}`,
    )
  )[0];

const webhookAttemptRows = (s: System, topupId: string): Promise<number> =>
  countOf(
    s.paymentAdmin,
    sql<{ n: number }>`
      select count(*) as n from webhook_attempts a
      join webhook_events w on w.event_id = a.event_id
      join charges c on c.id = w.charge_id where c.reference = ${topupId}`,
  );

const isChargeCreation = (info: Record<string, unknown>): boolean =>
  info.method === 'POST' && typeof info.url === 'string' && info.url.includes('/charges');

const isWebhookPost = (info: Record<string, unknown>): boolean =>
  info.method === 'POST' && typeof info.url === 'string' && info.url.includes('/webhooks/payment');

const setDecision =
  (decision: unknown) =>
  (info: Record<string, unknown>): void => {
    info.decision = decision;
  };

/** Mỗi kịch bản chỉ đếm log proxy của chính nó (hệ dùng chung cả nhóm). */
function resetProxyLogs(system: System | undefined): void {
  if (system === undefined) return;
  for (const proxy of [system.proxies.walletToPayment, system.proxies.paymentToWallet]) {
    proxy.log.length = 0;
    proxy.duplicateStatuses.length = 0;
  }
}

/** Ghi seed và nhật ký thao tác khi test thất bại để dựng lại (tests/chaos/.out/ đã được gitignore). */
function dumpOnFailure(get: () => System | undefined): void {
  afterEach(async (ctx) => {
    const system = get();
    if (ctx.task.result?.state !== 'fail' || system === undefined) return;
    const name = `${ctx.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-seed${system.seed}`;
    const path = await system.log.writeTo(OUT_DIR, name);
    console.error(`[chaos] seed=${system.seed}, nhật ký thao tác: ${path}`);
  });
}

describe('S6-S8: payment and webhook faults (in-process)', () => {
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
    resetProxyLogs(system);
  });
  dumpOnFailure(() => system);
  afterAll(async () => {
    await system?.stop();
  });

  /** Kiểm trạng thái cuối chung của S6: đúng một charge/khóa idempotency, ví +amount đúng một lần. */
  async function expectSingleCreditedCharge(
    s: System,
    customer: string,
    amount: number,
  ): Promise<TopupRow> {
    const topup = await topupOf(s, customer);
    expect(topup.status).toBe('SUCCEEDED');
    const charges = await chargesOf(s, topup.id);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.status).toBe('SUCCEEDED');
    expect(topup.charge_id).toBe(charges[0]?.id);
    expect(await idempotencyKeyRows(s, topup.id)).toBe(1);
    expect(await topupLedgerTransactions(s, topup.id)).toBe(1);
    expect(await balanceOf(s, customer)).toBe(amount);
    return topup;
  }

  it('S6: payment answers 503, then times out on the retry: topup retries by backoff, one charge, credited once', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's6a')).status).toBe(201);
    s.plan.add({
      point: 'wallet-to-payment.request',
      when: isChargeCreation,
      nth: 1,
      label: 's6a-503',
      action: setDecision({ status: 503 }),
    });
    // Trễ hơn timeout của wallet rồi mới chuyển tiếp: wallet bỏ cuộc (timeout) nhưng charge VẪN được tạo muộn (trường hợp mơ hồ).
    s.plan.add({
      point: 'wallet-to-payment.request',
      when: isChargeCreation,
      nth: 2,
      label: 's6a-timeout',
      action: setDecision({ delayMs: PAYMENT_TIMEOUT_MS + 500 }),
    });

    const created = await s.topup(TENANT, 's6a', 50_000, 'k-s6a');
    expect(created.status).toBe(202);
    await waitFor(() => s.plan.fired('s6a-timeout') === 1, { timeoutMs: 30_000, intervalMs: 50 });
    await s.heal();

    expect(s.plan.fired('s6a-503')).toBe(1);
    const topup = await expectSingleCreditedCharge(s, 's6a', 50_000);
    // Hai lần thử đầu đều bị tính là PAYMENT_UNAVAILABLE (503, rồi timeout) — chứng minh timeout xảy ra thật chứ không phải
    // yêu cầu bị trễ mà vẫn kịp trả lời.
    expect(topup.attempts).toBe(2);
    const decisions = s.proxies.walletToPayment.log
      .filter((e) => e.url.includes('/charges'))
      .map((e) => e.decision);
    expect(decisions).toContain('status');
    expect(decisions).toContain('delay');
    await assertSystemInvariants(s);
  });

  it('S6: charge request is lost before payment sees it: retried with the same key, one charge', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's6b')).status).toBe(201);
    const before = await totalCharges(s);
    let chargesAtDrop = -1;
    s.plan.add({
      point: 'wallet-to-payment.request',
      when: isChargeCreation,
      nth: 1,
      label: 's6b-503',
      action: setDecision({ status: 503 }),
    });
    s.plan.add({
      point: 'wallet-to-payment.request',
      when: isChargeCreation,
      nth: 2,
      label: 's6b-drop',
      action: async (info) => {
        // Yêu cầu thất lạc TRƯỚC khi payment nhận: tới lúc này payment chưa có charge nào của kịch bản.
        chargesAtDrop = (await totalCharges(s)) - before;
        info.decision = 'drop';
      },
    });

    expect((await s.topup(TENANT, 's6b', 20_000, 'k-s6b')).status).toBe(202);
    await waitFor(() => s.plan.fired('s6b-drop') === 1, { timeoutMs: 30_000, intervalMs: 50 });
    await s.heal();

    expect(chargesAtDrop).toBe(0);
    const topup = await expectSingleCreditedCharge(s, 's6b', 20_000);
    // 503 và yêu cầu bị mất là hai lần PAYMENT_UNAVAILABLE; lần thứ ba tạo được charge (webhook có thể chốt topup trước khi
    // wallet kịp ghi kết quả lần thứ ba nên attempts là 2 hoặc 3).
    expect([2, 3]).toContain(topup.attempts);
    expect(s.proxies.walletToPayment.log.map((e) => e.decision)).toContain('drop');
    await assertSystemInvariants(s);
  });

  it('S6: payment creates the charge but the response is lost: retried with the same key, still one charge', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's6c')).status).toBe(201);
    const before = await totalCharges(s);
    let chargesAtLoss = -1;
    s.plan.add({
      point: 'wallet-to-payment.response',
      when: isChargeCreation,
      nth: 1,
      label: 's6c-response-lost',
      action: async () => {
        // Phản hồi mất SAU khi payment đã xử lý: charge đã tồn tại nhưng wallet chỉ thấy lỗi kết nối.
        chargesAtLoss = (await totalCharges(s)) - before;
        throw new Error('mất phản hồi sau khi payment đã tạo charge');
      },
    });

    // Giữ webhook lại: nếu không, webhook của charge vừa tạo chốt topup ngay và wallet không bao giờ phải gửi lại (không thử
    // được đường replay theo khóa idempotency).
    s.plan.add({
      point: 'payment-to-wallet.request',
      when: isWebhookPost,
      label: 's6c-hold-webhook',
      action: setDecision('drop'),
    });

    expect((await s.topup(TENANT, 's6c', 30_000, 'k-s6c')).status).toBe(202);
    // Lần gửi thứ hai (replay) tới payment, wallet ghi nhận charge_id (PENDING) trong khi webhook vẫn bị giữ.
    await waitFor(
      async () =>
        s.plan.hits('wallet-to-payment.request') >= 2 &&
        (await topupOf(s, 's6c')).status === 'PENDING',
      { timeoutMs: 30_000, intervalMs: 50 },
    );
    expect(s.plan.fired('s6c-response-lost')).toBe(1);
    expect(chargesAtLoss).toBe(1);
    const replayed = await topupOf(s, 's6c');
    expect(await chargesOf(s, replayed.id)).toHaveLength(1);
    expect(replayed.attempts).toBe(2); // một lần mất phản hồi + lần replay thành công
    expect(await balanceOf(s, 's6c')).toBe(0);

    s.plan.clear(); // thả webhook
    await s.heal();

    await expectSingleCreditedCharge(s, 's6c', 30_000);
    expect(s.proxies.walletToPayment.log.map((e) => e.decision)).toContain('drop-response');
    await assertSystemInvariants(s);
  });

  it('S7: every webhook is lost: charge SUCCEEDED but wallet not credited until reconciliation repairs it exactly once', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's7')).status).toBe(201);
    // Không giới hạn số lần: mọi lần gửi webhook (cả các lần retry theo backoff) đều rớt kết nối.
    s.plan.add({
      point: 'payment-to-wallet.request',
      when: isWebhookPost,
      label: 's7-drop',
      action: setDecision('drop'),
    });

    expect((await s.topup(TENANT, 's7', 40_000, 'k-s7')).status).toBe(202);
    const { id: topupId } = await topupOf(s, 's7');
    // Chờ payment hết lượt gửi webhook (1 lần đầu + 3 lần retry) và đánh dấu FAILED.
    await waitFor(async () => (await webhookOf(s, topupId))?.status === 'FAILED', {
      timeoutMs: 60_000,
      intervalMs: 100,
    });
    s.plan.clear();
    await s.heal({ allowUnsettledTopups: true });

    const charges = await chargesOf(s, topupId);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.status).toBe('SUCCEEDED');
    expect(await webhookOf(s, topupId)).toEqual({ status: 'FAILED', attempts: 4 });
    expect(await webhookAttemptRows(s, topupId)).toBe(4);
    expect(
      s.proxies.paymentToWallet.log.filter(
        (e) => e.decision === 'drop' && e.url.includes('/webhooks/payment'),
      ),
    ).toHaveLength(4);
    // Wallet chưa hề biết: topup treo PENDING (đã có charge_id), ví 0, chưa có giao dịch TOPUP.
    const stuck = await topupOf(s, 's7');
    expect(stuck.status).toBe('PENDING');
    expect(stuck.charge_id).toBe(charges[0]?.id);
    expect(await balanceOf(s, 's7')).toBe(0);
    expect(await topupLedgerTransactions(s, topupId)).toBe(0);

    // INV-3 trước đối soát phải được giải thích đúng bằng MISSING_AT_WALLET; đối soát ghi bù, rồi mọi thứ chặt lại.
    await assertSystemInvariants(s, { expectMissingAtWallet: true });

    expect((await topupOf(s, 's7')).status).toBe('SUCCEEDED');
    expect(await balanceOf(s, 's7')).toBe(40_000);
    expect(await topupLedgerTransactions(s, topupId)).toBe(1); // ghi có ĐÚNG MỘT lần
  });

  it('S8: every webhook is delivered twice: credited once, the receiver answers 2xx both times', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's8a')).status).toBe(201);
    let body = '';
    s.plan.add({
      point: 'payment-to-wallet.request',
      when: isWebhookPost,
      label: 's8a-dup',
      action: (info) => {
        body = String(info.body);
        info.decision = 'duplicate';
      },
    });

    expect((await s.topup(TENANT, 's8a', 30_000, 'k-s8a')).status).toBe(202);
    const { id: topupId } = await topupOf(s, 's8a');
    await waitFor(() => s.proxies.paymentToWallet.duplicateStatuses.length >= 1, {
      timeoutMs: 30_000,
      intervalMs: 50,
    });
    await s.heal();

    const hooks = s.proxies.paymentToWallet.log.filter((e) => e.url.includes('/webhooks/payment'));
    expect(hooks.length).toBeGreaterThanOrEqual(1);
    // Bản gửi thứ nhất và THỨ HAI đều được wallet trả 2xx (idempotent), không có 5xx nào.
    expect(hooks.every((e) => e.decision === 'duplicate' && e.status === 200)).toBe(true);
    expect(s.proxies.paymentToWallet.duplicateStatuses).toHaveLength(hooks.length);
    expect(s.proxies.paymentToWallet.duplicateStatuses.every((st) => st === 200)).toBe(true);
    expect(await webhookOf(s, topupId)).toEqual({ status: 'DELIVERED', attempts: 1 });
    expect(await balanceOf(s, 's8a')).toBe(30_000);
    expect(await topupLedgerTransactions(s, topupId)).toBe(1);

    // Gửi lại thủ công chính thân webhook đó (ký lại) lần thứ ba: vẫn 200 và được nhận ra là trùng.
    const replay = await fetch(`${s.walletUrl}/webhooks/payment`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': signWebhook(SECRET, body, Math.floor(Date.now() / 1000)),
      },
      body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ outcome: 'DUPLICATE' });
    expect(await balanceOf(s, 's8a')).toBe(30_000);
    expect(await topupLedgerTransactions(s, topupId)).toBe(1);
    await assertSystemInvariants(s);
  });

  it('S8: webhook held back while reconciliation credits first: the late webhook changes nothing and is acknowledged', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's8b')).status).toBe(201);
    const HOLD_MS = 8_000;
    s.plan.add({
      point: 'payment-to-wallet.request',
      when: isWebhookPost,
      times: 1,
      label: 's8b-hold',
      action: setDecision({ delayMs: HOLD_MS }),
    });

    expect((await s.topup(TENANT, 's8b', 25_000, 'k-s8b')).status).toBe(202);
    const { id: topupId } = await topupOf(s, 's8b');
    await waitFor(() => s.plan.fired('s8b-hold') === 1, { timeoutMs: 30_000, intervalMs: 50 });
    // Webhook đang bị giữ: payment đã chốt charge nhưng wallet chưa biết.
    expect((await chargesOf(s, topupId))[0]?.status).toBe('SUCCEEDED');
    expect((await topupOf(s, 's8b')).status).toBe('PENDING');
    expect(await balanceOf(s, 's8b')).toBe(0);

    // Đối soát thủ công (autofix bật) ghi bù TRƯỚC khi webhook kịp tới.
    const days = await reconcileDaysOf(s, [{ name: TENANT, schema: `t_${TENANT}` }], []);
    const applied: string[] = [];
    for (const day of days) {
      const run = await runReconciliationViaHttp(s, TENANT, day, 1);
      expect(run.status).toBe('COMPLETED');
      for (const item of run.items) {
        if (item.kind === 'MISSING_AT_WALLET' && item.topupId === topupId) {
          applied.push(item.action);
        }
      }
    }
    expect(applied).toEqual(['AUTO_APPLIED']);
    expect((await topupOf(s, 's8b')).status).toBe('SUCCEEDED');
    expect(await balanceOf(s, 's8b')).toBe(25_000);
    // Tiền điều kiện của kịch bản: webhook vẫn chưa tới (nếu đối soát chậm hơn thời gian giữ thì test này không còn ý nghĩa).
    expect(
      s.proxies.paymentToWallet.log.filter((e) => e.url.includes('/webhooks/payment')),
    ).toEqual([]);

    // Webhook muộn tới: không đổi gì, wallet vẫn trả 2xx nên payment không phải retry.
    await waitFor(
      () => s.proxies.paymentToWallet.log.some((e) => e.url.includes('/webhooks/payment')),
      { timeoutMs: 30_000, intervalMs: 50 },
    );
    await s.heal();

    const hooks = s.proxies.paymentToWallet.log.filter((e) => e.url.includes('/webhooks/payment'));
    expect(hooks).toEqual([expect.objectContaining({ decision: 'delay', status: 200 })]);
    expect(await webhookOf(s, topupId)).toEqual({ status: 'DELIVERED', attempts: 1 });
    expect(await webhookAttemptRows(s, topupId)).toBe(1);
    expect(await balanceOf(s, 's8b')).toBe(25_000);
    expect(await topupLedgerTransactions(s, topupId)).toBe(1);
    expect(await chargesOf(s, topupId)).toHaveLength(1);
    await assertSystemInvariants(s);
  });
});

describe('S9-S10: real SIGKILL of wallet and payment (child processes)', () => {
  let system: ChildSystem | undefined;
  const sys = (): ChildSystem => {
    if (system === undefined) throw new Error('hệ thống chưa dựng xong');
    return system;
  };

  beforeAll(async () => {
    // Lịch webhook dài hơn mặc định: wallet chết vài giây rồi mới dựng lại, webhook không được hết lượt trong lúc đó.
    system = await createSystem({
      mode: 'child',
      tenants: [TENANT],
      webhookBackoffSeconds: [2, 5, 10, 20, 30],
    });
  });
  beforeEach(() => {
    system?.plan.clear();
    system?.plan.enable();
    resetProxyLogs(system);
  });
  dumpOnFailure(() => system);
  // stop() giết mọi tiến trình con (kể cả đã bị crash) và xác nhận không còn pid nào, kể cả khi test thất bại giữa chừng.
  afterAll(async () => {
    await system?.stop();
  });

  it('S9: wallet SIGKILLed after payment created the charge but before it stored charge_id: resubmitted with the same key, one charge, credited once', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's9')).status).toBe(201);
    const before = await totalCharges(s);
    let crashed = false;
    let chargesAtCrash = -1;
    // Hook .response: payment đã xử lý xong và có phản hồi, wallet CHƯA nhận nó (proxy còn giữ) → SIGKILL wallet ngay tại đây.
    s.plan.add({
      point: 'wallet-to-payment.response',
      when: isChargeCreation,
      nth: 1,
      label: 's9-crash',
      action: async () => {
        chargesAtCrash = (await totalCharges(s)) - before;
        await s.crashWallet();
        crashed = true;
      },
    });
    // Giữ mọi webhook lại cho tới khi chứng minh được việc gửi lại: nếu không, webhook tới sau khi wallet khởi động lại có thể
    // chốt topup trước và wallet không bao giờ phải gửi lại.
    s.plan.add({
      point: 'payment-to-wallet.request',
      when: isWebhookPost,
      label: 's9-hold-webhook',
      action: setDecision('drop'),
    });

    expect((await s.topup(TENANT, 's9', 45_000, 'k-s9')).status).toBe(202);
    await waitFor(() => crashed, { timeoutMs: 60_000, intervalMs: 50 });

    // Tiền điều kiện: payment ĐÃ có đúng một charge, còn topup của wallet chưa có charge_id (chưa kịp lưu).
    expect(chargesAtCrash).toBe(1);
    const stuck = await topupOf(s, 's9');
    expect(stuck.status).toBe('REQUESTED');
    expect(stuck.charge_id).toBeNull();
    const charges = await chargesOf(s, stuck.id);
    expect(charges).toHaveLength(1);
    expect(await idempotencyKeyRows(s, stuck.id)).toBe(1);
    expect(s.pids().wallet).toBeUndefined();
    expect(s.plan.hits('wallet-to-payment.request')).toBe(1); // mới có đúng yêu cầu tạo charge đầu tiên

    await s.restartWallet();
    // Wallet chỉ thử lại sau khi lease 60s của lần chiếm trước hết hạn (thiết kế); mô phỏng thời gian trôi qua bằng cách đưa
    // lịch về hiện tại thay vì chờ cả phút.
    await rowsOf(
      s.walletAdmin,
      sql`update t_acme.topups set next_attempt_at = sysutcdatetime() where status = 'REQUESTED'`,
    );
    await waitFor(() => s.plan.hits('wallet-to-payment.request') >= 2, {
      timeoutMs: 60_000,
      intervalMs: 100,
    });
    await waitFor(async () => (await topupOf(s, 's9')).status === 'PENDING', {
      timeoutMs: 60_000,
      intervalMs: 100,
    });

    // Gửi lại cùng khóa: payment trả lại đúng charge cũ (replay), không tạo charge thứ hai; webhook vẫn đang bị giữ.
    const resubmitted = await topupOf(s, 's9');
    expect(resubmitted.charge_id).toBe(charges[0]?.id);
    expect(await chargesOf(s, stuck.id)).toHaveLength(1);
    expect(await idempotencyKeyRows(s, stuck.id)).toBe(1);
    expect(await balanceOf(s, 's9')).toBe(0);

    s.plan.clear(); // thả webhook
    await s.heal();

    expect((await topupOf(s, 's9')).status).toBe('SUCCEEDED');
    expect(await chargesOf(s, stuck.id)).toHaveLength(1);
    expect(await idempotencyKeyRows(s, stuck.id)).toBe(1);
    expect(await balanceOf(s, 's9')).toBe(45_000);
    expect(await topupLedgerTransactions(s, stuck.id)).toBe(1);
    await assertSystemInvariants(s);
  }, 240_000);

  it('S10: payment SIGKILLed after the charge succeeded but before any webhook was delivered: webhook delivered after restart, credited once', async () => {
    const s = sys();
    expect((await s.openWallet(TENANT, 's10')).status).toBe(201);
    const logStart = s.proxies.paymentToWallet.log.length; // bỏ qua log của kịch bản trước trong cùng hệ
    // Mọi webhook rớt kết nối cho tới khi payment bị giết: wallet không hề nhận được gì.
    s.plan.add({
      point: 'payment-to-wallet.request',
      when: isWebhookPost,
      label: 's10-drop',
      action: setDecision('drop'),
    });

    expect((await s.topup(TENANT, 's10', 35_000, 'k-s10')).status).toBe(202);
    const { id: topupId } = await topupOf(s, 's10');
    // Charge đã SUCCEEDED và lần gửi đầu đã bị rớt VÀ đã được ghi nhận (attempts >= 1: lịch retry đã đặt, hết lease).
    await waitFor(
      async () => {
        const charge = (await chargesOf(s, topupId))[0];
        const hook = await webhookOf(s, topupId);
        return charge?.status === 'SUCCEEDED' && hook?.status === 'PENDING' && hook.attempts >= 1;
      },
      { timeoutMs: 60_000, intervalMs: 20 },
    );

    await s.crashPayment();
    s.plan.clear(); // sau khi payment sống lại, webhook đi thẳng tới wallet

    // Tiền điều kiện: charge chốt, webhook còn nằm trong DB của payment (chưa giao), wallet chưa biết gì.
    expect(s.pids().payment).toBeUndefined();
    expect((await chargesOf(s, topupId))[0]?.status).toBe('SUCCEEDED');
    const pending = await webhookOf(s, topupId);
    expect(pending?.status).toBe('PENDING');
    const sinceStart = s.proxies.paymentToWallet.log.slice(logStart);
    expect(sinceStart.length).toBeGreaterThanOrEqual(1);
    expect(sinceStart.every((e) => e.decision === 'drop')).toBe(true);
    expect((await topupOf(s, 's10')).status).toBe('PENDING');
    expect(await balanceOf(s, 's10')).toBe(0);

    await s.restartPayment();
    await s.heal();

    // Hàng đợi trong DB của payment giao webhook sau khi khởi động lại.
    const delivered = await webhookOf(s, topupId);
    expect(delivered?.status).toBe('DELIVERED');
    expect(delivered?.attempts).toBeGreaterThan(pending?.attempts ?? 0);
    expect(await chargesOf(s, topupId)).toHaveLength(1);
    expect((await topupOf(s, 's10')).status).toBe('SUCCEEDED');
    expect(await balanceOf(s, 's10')).toBe(35_000);
    expect(await topupLedgerTransactions(s, topupId)).toBe(1);
    await assertSystemInvariants(s);
  }, 240_000);
});
