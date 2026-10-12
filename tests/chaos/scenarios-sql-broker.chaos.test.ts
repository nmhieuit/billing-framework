import { join } from 'node:path';
import { waitFor } from '@billing/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSystemInvariants } from './support/invariants.js';
import { killSessions } from './support/sql-faults.js';
import { adminQuery, createSystem, type System } from './support/system-harness.js';

/**
 * Kịch bản S1-S5: lỗi SQL Server và RabbitMQ quanh đường trả đơn (PayOrder → outbox → relay → Orders giả).
 *
 * Một hệ dùng chung cho cả tệp; mỗi kịch bản dùng khách/đơn riêng và `plan.clear()` ở beforeEach nên lỗi không rò sang
 * kịch bản sau. Mỗi kịch bản: nạp ví bình thường → bật lỗi → hành động → chờ lỗi THỰC SỰ xảy ra (heal() tắt plan ngay)
 * → heal() → assertSystemInvariants (một lần) + kiểm tra riêng (đếm chính xác).
 *
 * Cấu hình harness: retryDelaysSeconds = [1, 2] nên consumer cho tối đa 3 lần xử lý một message (lần 3 thất bại ⇒ DLQ).
 */

const TENANT = 'acme';
const OUT_DIR = join(import.meta.dirname, '.out');

let system: System | undefined;
// Móc consumer của kịch bản đang chạy (S3); harness chỉ nhận một hàm cố định lúc dựng nên đi vòng qua biến này.
let afterHandled: (() => Promise<void>) | undefined;

const sys = (): System => {
  if (system === undefined) throw new Error('hệ thống chưa dựng xong');
  return system;
};

beforeAll(async () => {
  system = await createSystem({
    tenants: [TENANT],
    afterOrderHandled: async () => {
      await afterHandled?.();
    },
  });
});

beforeEach(() => {
  system?.plan.clear();
  afterHandled = undefined;
});

// Thất bại thì ghi seed và nhật ký thao tác để dựng lại (tests/chaos/.out/ đã được gitignore).
afterEach(async (ctx) => {
  if (ctx.task.result?.state !== 'fail' || system === undefined) return;
  const name = `${ctx.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-seed${system.seed}`;
  const path = await system.log.writeTo(OUT_DIR, name);
  console.error(`[chaos] seed=${system.seed}, nhật ký thao tác: ${path}`);
});

afterAll(async () => {
  await system?.stop();
});

const count = async (s: System, query: ReturnType<typeof sql<{ n: number }>>): Promise<number> => {
  const result = await adminQuery(s.walletAdmin, (db) => query.execute(db));
  return Number(result.rows[0]?.n ?? 0);
};

const balanceOf = async (s: System, customer: string): Promise<number> => {
  const result = await adminQuery(s.walletAdmin, (db) =>
    sql<{ balance: string }>`
      select balance from t_acme.accounts where customer_id = ${customer}`.execute(db),
  );
  return Number(result.rows[0]?.balance);
};

const orderPayments = (s: System, orderId: string): Promise<number> =>
  count(
    s,
    sql<{ n: number }>`select count(*) as n from t_acme.order_payments where order_id = ${orderId}`,
  );

const orderLedgerTransactions = (s: System, orderId: string): Promise<number> =>
  count(
    s,
    sql<{
      n: number;
    }>`select count(*) as n from t_acme.ledger_transactions where kind = 'ORDER_PAYMENT' and business_key = ${`order:${orderId}`}`,
  );

const inboxRows = (s: System, eventId: string): Promise<number> =>
  count(
    s,
    sql<{
      n: number;
    }>`select count(*) as n from t_acme.processed_messages where message_id = ${eventId}`,
  );

/** Các OrderPaidV1 Orders giả đã nhận cho một đơn. */
const paidEvents = (s: System, orderId: string) =>
  s.orders.received().filter((r) => r.eventType === 'OrderPaidV1' && r.payload.orderId === orderId);

/** Số dòng outbox OrderPaidV1 của đơn (tất định: không phụ thuộc việc relay đã gửi chưa). */
const outboxPaidRows = (s: System, orderId: string): Promise<number> =>
  count(
    s,
    sql<{
      n: number;
    }>`select count(*) as n from t_acme.outbox where event_type = 'OrderPaidV1' and json_value(payload, '$.orderId') = ${orderId}`,
  );

/** Orders nhận >= 1 bản OrderPaidV1; mọi bản trùng cùng messageId và cùng payload (at-least-once). */
function expectIdenticalReceipts(s: System, orderId: string): void {
  const events = paidEvents(s, orderId);
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(new Set(events.map((r) => r.messageId)).size).toBe(1);
  for (const r of events) expect(r.payload).toEqual(events[0]?.payload);
}

/** Mở ví và nạp tiền bình thường (chưa có lỗi), chờ hội tụ; heal() tắt plan nên bật lại để rule có hiệu lực. */
async function fundedWallet(s: System, customer: string, amount: number): Promise<void> {
  expect((await s.openWallet(TENANT, customer)).status).toBe(201);
  expect((await s.topup(TENANT, customer, amount, `fund-${customer}`)).status).toBe(202);
  await s.heal();
  expect(await balanceOf(s, customer)).toBe(amount);
  s.plan.enable();
}

const isOrderPaymentInsert = (info: Record<string, unknown>): boolean =>
  info.name === 'wallet' &&
  typeof info.sql === 'string' &&
  info.sql.startsWith('insert') &&
  info.sql.includes('order_payments');

const isInboxInsert = (info: Record<string, unknown>): boolean =>
  info.name === 'wallet' &&
  typeof info.sql === 'string' &&
  info.sql.includes('processed_messages') &&
  info.sql.startsWith('insert');

describe('S1-S5: SQL Server and RabbitMQ failures around order payment', () => {
  it('S1: session killed before the order_payments insert leaves no debit, and the redelivered order is paid exactly once', async () => {
    const s = sys();
    await fundedWallet(s, 's1', 100_000);
    const order = { tenant: TENANT, customer: 's1', amount: 30_000 };
    const orderId = crypto.randomUUID();
    // Ảnh chụp ngay sau khi KILL (trong action): thời điểm tất định, không đua với lần giao lại.
    let atKill: { payments: number; ledger: number; balance: number } | undefined;
    s.plan.add({
      point: 'sql.query.before',
      nth: 1,
      label: 's1-kill',
      when: isOrderPaymentInsert,
      action: async () => {
        await killSessions(s.walletDb);
        atKill = {
          payments: await orderPayments(s, orderId),
          ledger: await orderLedgerTransactions(s, orderId),
          balance: await balanceOf(s, 's1'),
        };
      },
    });
    // Đếm số lần handler thử ghi inbox để chứng minh có giao lại.
    s.plan.add({
      point: 'sql.query.before',
      label: 's1-inbox',
      when: isInboxInsert,
      action: () => undefined,
    });

    // Đếm các lệnh insert order_payments (cùng matcher với rule KILL): phải đúng 2, một bị giết và một thật.
    s.plan.add({
      point: 'sql.query.before',
      label: 's1-insert',
      when: isOrderPaymentInsert,
      action: () => undefined,
    });

    await s.sendOrder({ ...order, orderId });
    await waitFor(() => atKill !== undefined, { timeoutMs: 30_000, intervalMs: 50 });
    // Lần thử đầu bị giết trước khi ghi nợ: không có khoản trả, không có bút toán, ví còn nguyên.
    expect(atKill).toEqual({ payments: 0, ledger: 0, balance: 100_000 });
    // Chờ lần giao lại thật sự chạm tới insert (heal() sẽ tắt plan).
    await waitFor(() => s.plan.fired('s1-insert') >= 2, { timeoutMs: 30_000, intervalMs: 50 });
    await s.heal();

    expect(s.plan.fired('s1-kill')).toBe(1);
    // Đúng hai lần insert: lần 1 bị giết trước khi chạy (rollback), lần 2 là khoản trả thật.
    expect(s.plan.fired('s1-insert')).toBe(2);
    expect(s.plan.fired('s1-inbox')).toBeGreaterThanOrEqual(2);
    expect(await orderPayments(s, orderId)).toBe(1);
    expect(await orderLedgerTransactions(s, orderId)).toBe(1);
    expect(await balanceOf(s, 's1')).toBe(70_000);
    // Lần đầu rollback nên chỉ có một dòng outbox OrderPaidV1.
    expect(await outboxPaidRows(s, orderId)).toBe(1);
    expectIdenticalReceipts(s, orderId);
    await assertSystemInvariants(s);
  });

  it('S2: session killed right after commit, before ack: redelivery does not debit twice', async () => {
    const s = sys();
    await fundedWallet(s, 's2', 100_000);
    const orderId = crypto.randomUUID();
    // Worker nền (relay, topup) cũng commit liên tục nên phải gắn lỗi vào ĐÚNG kết nối của transaction trả đơn.
    let armedConnection: unknown;
    let atKill: { payments: number; ledger: number; balance: number } | undefined;
    // Commit không mang SQL: rule sau lệnh insert order_payments ghi lại kết nối của transaction (info.connection).
    s.plan.add({
      point: 'sql.query.after',
      label: 's2-arm',
      when: isOrderPaymentInsert,
      action: (info) => {
        armedConnection = info.connection;
      },
    });
    s.plan.add({
      point: 'sql.commit.after',
      times: 1,
      label: 's2-kill',
      when: (info) =>
        info.name === 'wallet' &&
        armedConnection !== undefined &&
        info.connection === armedConnection,
      action: async () => {
        await killSessions(s.walletDb);
        atKill = {
          payments: await orderPayments(s, orderId),
          ledger: await orderLedgerTransactions(s, orderId),
          balance: await balanceOf(s, 's2'),
        };
        // Mô phỏng tiến trình chết sau commit: client chỉ thấy lỗi kết nối dù server đã commit.
        throw new Error('KILL sau commit, trước ack');
      },
    });
    s.plan.add({
      point: 'sql.query.before',
      label: 's2-inbox',
      when: isInboxInsert,
      action: () => undefined,
    });

    const { eventId } = await s.sendOrder({
      tenant: TENANT,
      customer: 's2',
      amount: 30_000,
      orderId,
    });
    await waitFor(() => atKill !== undefined, { timeoutMs: 30_000, intervalMs: 50 });
    // Giao dịch ĐÃ commit trước khi bị giết: khoản trả đã tồn tại và ví đã bị trừ.
    expect(atKill).toEqual({ payments: 1, ledger: 1, balance: 70_000 });
    await waitFor(() => s.plan.fired('s2-inbox') >= 2, { timeoutMs: 30_000, intervalMs: 50 });
    await s.heal();

    expect(s.plan.fired('s2-kill')).toBe(1);
    expect(s.plan.fired('s2-inbox')).toBeGreaterThanOrEqual(2); // đã giao lại
    expect(await orderPayments(s, orderId)).toBe(1);
    expect(await orderLedgerTransactions(s, orderId)).toBe(1);
    expect(await balanceOf(s, 's2')).toBe(70_000); // trừ đúng một lần
    expect(await inboxRows(s, eventId)).toBe(1);
    // Outbox được commit cùng khoản trả, lần giao lại là DUPLICATE (cùng eventId) nên không thêm sự kiện.
    expect(await outboxPaidRows(s, orderId)).toBe(1);
    expectIdenticalReceipts(s, orderId);
    await assertSystemInvariants(s);
  });

  it('S3: consumer dies before ack twice (within the retry budget): converges to one payment, no dead letter', async () => {
    const s = sys();
    await fundedWallet(s, 's3a', 100_000);
    let calls = 0;
    // retryDelaysSeconds [1, 2] cho 3 lần xử lý: hai lần chết rồi lần thứ ba qua.
    afterHandled = async () => {
      calls += 1;
      if (calls <= 2) throw new Error(`consumer chết trước ack (lần ${calls})`);
    };

    const { orderId, eventId } = await s.sendOrder({
      tenant: TENANT,
      customer: 's3a',
      amount: 30_000,
    });
    await waitFor(() => calls >= 3, { timeoutMs: 60_000, intervalMs: 50 });
    await s.heal();

    expect(calls).toBe(3);
    expect(await s.deadLettered()).not.toContain(eventId);
    expect(await orderPayments(s, orderId)).toBe(1);
    expect(await orderLedgerTransactions(s, orderId)).toBe(1);
    expect(await balanceOf(s, 's3a')).toBe(70_000);
    expect(await outboxPaidRows(s, orderId)).toBe(1);
    expectIdenticalReceipts(s, orderId);
    await assertSystemInvariants(s);
  });

  it('S3: consumer dies before ack three times (retries exhausted): payment stays single, the message is dead-lettered', async () => {
    const s = sys();
    await fundedWallet(s, 's3b', 100_000);
    let calls = 0;
    afterHandled = async () => {
      calls += 1;
      throw new Error(`consumer chết trước ack (lần ${calls})`);
    };

    const { orderId, eventId } = await s.sendOrder({
      tenant: TENANT,
      customer: 's3b',
      amount: 30_000,
    });
    await waitFor(async () => (await s.deadLettered()).includes(eventId), {
      timeoutMs: 60_000,
      intervalMs: 100,
    });
    afterHandled = undefined;
    await s.heal();

    // Ba lần giao = 1 + 2 lần thử lại; sau lần thứ ba hết lượt nên vào DLQ — dù tiền đã trả từ lần đầu.
    expect(calls).toBe(3);
    expect(await s.deadLettered()).toContain(eventId);
    expect(await orderPayments(s, orderId)).toBe(1);
    expect(await orderLedgerTransactions(s, orderId)).toBe(1);
    expect(await balanceOf(s, 's3b')).toBe(70_000);
    expect(await outboxPaidRows(s, orderId)).toBe(1);
    expectIdenticalReceipts(s, orderId);
    await assertSystemInvariants(s);
  });

  it('S3c: connection dies after commit, before ack (real unacked redelivery): paid once, redelivery is DUPLICATE, no dead letter', async () => {
    const s = sys();
    await fundedWallet(s, 's3c', 100_000);
    let calls = 0;
    let dropped = 0;
    // Một lần duy nhất: kênh chết sau commit nên ack thất bại, broker requeue (redelivered=true) khi nối lại.
    afterHandled = async () => {
      calls += 1;
      if (calls === 1) dropped = await s.dropWalletBrokerConnections();
    };
    s.plan.add({
      point: 'sql.query.before',
      label: 's3c-inbox',
      when: isInboxInsert,
      action: () => undefined,
    });

    const { orderId, eventId } = await s.sendOrder({
      tenant: TENANT,
      customer: 's3c',
      amount: 30_000,
    });
    await waitFor(() => calls >= 2 && s.plan.fired('s3c-inbox') >= 2, {
      timeoutMs: 60_000,
      intervalMs: 50,
    });
    await s.heal();

    expect(dropped).toBeGreaterThan(0);
    expect(calls).toBe(2); // lần giao lại xử lý đúng một lần nữa
    expect(await s.deadLettered()).not.toContain(eventId); // DLQ dùng chung cả tệp (S3b để lại một message)
    expect(await inboxRows(s, eventId)).toBe(1); // lần giao lại là DUPLICATE
    expect(await orderPayments(s, orderId)).toBe(1);
    expect(await orderLedgerTransactions(s, orderId)).toBe(1);
    expect(await balanceOf(s, 's3c')).toBe(70_000);
    expect(await outboxPaidRows(s, orderId)).toBe(1);
    expectIdenticalReceipts(s, orderId);
    await assertSystemInvariants(s);
  });

  it('S2b: same orderId redelivered with a NEW eventId after payment: REPLAYED, second OrderPaidV1, debited once', async () => {
    const s = sys();
    await fundedWallet(s, 's2b', 100_000);
    const first = await s.sendOrder({ tenant: TENANT, customer: 's2b', amount: 30_000 });
    await s.heal();
    expect(await balanceOf(s, 's2b')).toBe(70_000);
    const second = await s.sendOrder({
      tenant: TENANT,
      customer: 's2b',
      amount: 30_000,
      orderId: first.orderId,
    });
    expect(second.eventId).not.toBe(first.eventId);
    await s.heal();

    const events = paidEvents(s, first.orderId);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((r) => r.messageId)).size).toBe(2); // eventId mới
    expect(events[1]?.payload.walletTransactionId).toBe(events[0]?.payload.walletTransactionId);
    expect(events[1]?.payload.amount).toEqual(events[0]?.payload.amount);
    expect(await outboxPaidRows(s, first.orderId)).toBe(2);
    expect(await orderPayments(s, first.orderId)).toBe(1);
    expect(await orderLedgerTransactions(s, first.orderId)).toBe(1);
    expect(await balanceOf(s, 's2b')).toBe(70_000); // chỉ trừ một lần
    await assertSystemInvariants(s);
  });

  it('S4: relay publishes then fails before markSent: Orders gets identical duplicates, none lost, outbox ends SENT', async () => {
    const s = sys();
    await fundedWallet(s, 's4', 100_000);
    s.plan.add({
      point: 'broker.publish.after',
      nth: 1,
      label: 's4-lost-ack',
      when: (info) => info.eventType === 'OrderPaidV1',
      action: () => {
        throw new Error('mất kết nối ngay sau publish');
      },
    });

    const { orderId } = await s.sendOrder({ tenant: TENANT, customer: 's4', amount: 30_000 });
    await waitFor(() => s.plan.fired('s4-lost-ack') === 1, { timeoutMs: 30_000, intervalMs: 50 });
    await s.heal();

    expect(s.plan.fired('s4-lost-ack')).toBe(1);
    const paid = paidEvents(s, orderId);
    // Lần publish đầu đã tới broker (relay tưởng thất bại) + lần relay gửi lại.
    expect(paid).toHaveLength(2);
    expectIdenticalReceipts(s, orderId);
    expect(await outboxPaidRows(s, orderId)).toBe(1);
    const outbox = await adminQuery(s.walletAdmin, (db) =>
      sql<{ status: string; attempts: number }>`
        select status, attempts from t_acme.outbox
        where event_type = 'OrderPaidV1' and id = ${paid[0]?.messageId as string}`.execute(db),
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]?.status).toBe('SENT');
    expect(outbox.rows[0]?.attempts).toBe(1); // đúng một lần bị tính là thất bại
    expect(await orderPayments(s, orderId)).toBe(1);
    expect(await balanceOf(s, 's4')).toBe(70_000);
    await assertSystemInvariants(s);
  });

  it('S5: AMQP connections dropped twice while consuming ten orders: all paid exactly once, none lost', async () => {
    const s = sys();
    await fundedWallet(s, 's5', 1_000_000);
    const orderIds: string[] = [];
    // Cắt kết nối tất định từ móc consumer (sau commit, trước ack) ở lần xử lý thứ 4 và thứ 8, không dựa vào thời gian.
    let calls = 0;
    const dropped: number[] = [];
    afterHandled = async () => {
      calls += 1;
      if (calls === 4 || calls === 8) dropped.push(await s.dropWalletBrokerConnections());
    };
    const eventIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const sent = await s.sendOrder({ tenant: TENANT, customer: 's5', amount: 10_000 });
      orderIds.push(sent.orderId);
      eventIds.push(sent.eventId);
    }
    await waitFor(() => dropped.length === 2, { timeoutMs: 60_000, intervalMs: 50 });
    await s.heal();

    expect(dropped).toHaveLength(2);
    expect(dropped.every((n) => n > 0)).toBe(true);
    // Ack mất cùng kênh nên các message đang xử lý bị broker giao lại: số lần xử lý > 10.
    expect(calls).toBeGreaterThan(10);
    const dead = await s.deadLettered();
    for (const eventId of eventIds) expect(dead).not.toContain(eventId);
    expect(orderIds).toHaveLength(10);
    const paidCount = await count(
      s,
      sql<{ n: number }>`select count(*) as n from t_acme.order_payments where customer_id = 's5'`,
    );
    expect(paidCount).toBe(10);
    for (const orderId of orderIds) {
      expect(await orderPayments(s, orderId)).toBe(1);
      const events = paidEvents(s, orderId);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(new Set(events.map((r) => r.messageId)).size).toBe(1);
    }
    expect(await balanceOf(s, 's5')).toBe(900_000);
    await assertSystemInvariants(s);
  });
});
