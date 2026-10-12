import { randomUUID } from 'node:crypto';
import { validateEvent } from '@billing/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import { RecordingMetrics } from '../test-support-metrics.js';
import {
  blockedRequestCount,
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  holdWalletLock,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { EventIdUnknownError, OrderNotFoundError, OrderReversedError } from './errors.js';
import { OpsActionRecorder } from './ops-recorder.js';
import { PayOrder } from './pay-order.js';
import { ReplayOrderPaid } from './replay-order-paid.js';
import { ReverseTransaction } from './reverse-transaction.js';

let h: Harness;
let replay: ReplayOrderPaid;
let reverse: ReverseTransaction;
let pay: PayOrder;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  const recorder = new OpsActionRecorder({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    metrics: new RecordingMetrics(),
  });
  replay = new ReplayOrderPaid({ recorder, ids: h.ids });
  reverse = new ReverseTransaction({ recorder, ids: h.ids });
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const request = (orderId: string, overrides: Record<string, unknown> = {}) => ({
  tenant: h.acme,
  orderId,
  actor: 'op@x',
  reason: 'consumer missed event',
  idempotencyKey: `rp-key-${++counter}`,
  ...overrides,
});
const outboxFor = async (orderId: string) =>
  (
    await h.db
      .withSchema(schema(h.acme))
      .selectFrom('outbox')
      .selectAll()
      .where('payload', 'like', `%${orderId}%`)
      .where('event_type', '=', 'OrderPaidV1')
      .orderBy('created_at')
      .orderBy('id')
      .execute()
  ).map((row) => ({ ...row, body: JSON.parse(row.payload) as Record<string, unknown> }));
const txCount = async (): Promise<number> =>
  (await h.db.withSchema(schema(h.acme)).selectFrom('ledger_transactions').select('id').execute())
    .length;

/** Tạo một đơn đã trả và mô phỏng dòng `order_payments` với `paid_event_id` biết trước (hoặc null cho đơn cũ). */
const paidOrder = async (withEventId = true) => {
  const customer = `rp${++counter}`;
  await fundWallet(h, { customer, amount: 100000 });
  const orderId = randomUUID();
  h.clock.advanceSeconds(5);
  const outcome = await pay.execute({
    tenant: h.acme,
    eventId: randomUUID(),
    correlationId: 'corr-1',
    orderId,
    customerId: customer,
    amount: 50000,
    currency: 'VND',
  });
  if (outcome.kind !== 'PAID') throw new Error('order not paid');
  const paidEventId = randomUUID();
  // PayOrder đã ghi paid_event_id thật; ở đây ghi đè bằng id đã biết, hoặc xóa để mô phỏng đơn trả trước khi có cột này.
  await h.db
    .withSchema(schema(h.acme))
    .updateTable('order_payments')
    .set({ paid_event_id: withEventId ? paidEventId : null })
    .where('order_id', '=', orderId)
    .execute();
  return { orderId, paidEventId, transactionId: outcome.walletTransactionId };
};

describe('ReplayOrderPaid', () => {
  it('queues exactly one new OrderPaidV1 row reusing the original event id and paid time', async () => {
    const { orderId, paidEventId } = await paidOrder();
    const before = await outboxFor(orderId);
    const txBefore = await txCount();
    h.clock.advanceSeconds(3600);

    const out = await replay.execute(request(orderId));

    expect(out.eventId).toBe(paidEventId);
    const rows = await outboxFor(orderId);
    expect(rows).toHaveLength(before.length + 1);
    const added = rows.find((r) => !before.some((b) => b.id === r.id));
    expect(added).toBeDefined();
    expect(added?.id).not.toBe(paidEventId);
    expect(added?.status).toBe('PENDING');
    expect(added?.correlation_id).toBe(`ops-replay:${out.actionId}`);
    expect(added?.body).toMatchObject({
      eventId: paidEventId,
      orderId,
      correlationId: `ops-replay:${out.actionId}`,
    });
    expect(added?.body['paidAtUtc']).toBe(added?.body['occurredAtUtc']);
    expect(added?.body['paidAtUtc']).toBe('2026-10-10T10:00:05.000Z');
    expect(validateEvent('OrderPaidV1', added?.body).ok).toBe(true);
    expect(await txCount()).toBe(txBefore);
  });

  it('two replays with different keys give two outbox rows with the same event id', async () => {
    const { orderId, paidEventId } = await paidOrder();
    const before = await outboxFor(orderId);
    await replay.execute(request(orderId));
    await replay.execute(request(orderId));
    const rows = await outboxFor(orderId);
    expect(rows).toHaveLength(before.length + 2);
    const replayed = rows.filter((r) => !before.some((b) => b.id === r.id));
    expect(replayed.map((r) => r.body['eventId'])).toEqual([paidEventId, paidEventId]);
    expect(new Set(replayed.map((r) => r.id)).size).toBe(2);
  });

  it('is idempotent for the same key', async () => {
    const { orderId } = await paidOrder();
    const before = (await outboxFor(orderId)).length;
    const req = request(orderId);
    const first = await replay.execute(req);
    const second = await replay.execute(req);
    expect(second).toEqual(first);
    expect(await outboxFor(orderId)).toHaveLength(before + 1);
  });

  it('rejects an unknown order', async () => {
    await expect(replay.execute(request(randomUUID()))).rejects.toBeInstanceOf(OrderNotFoundError);
  });

  it('rejects an order whose OrderPaidV1 event id is unknown', async () => {
    const { orderId } = await paidOrder(false);
    await expect(replay.execute(request(orderId))).rejects.toBeInstanceOf(EventIdUnknownError);
  });

  it('rejects an order whose payment was reversed', async () => {
    const { orderId, transactionId } = await paidOrder();
    await reverse.execute({
      tenant: h.acme,
      transactionId,
      actor: 'op@x',
      reason: 'refund',
      idempotencyKey: `rp-rev-${++counter}`,
    });
    const before = (await outboxFor(orderId)).length;
    await expect(replay.execute(request(orderId))).rejects.toBeInstanceOf(OrderReversedError);
    expect(await outboxFor(orderId)).toHaveLength(before);
  });

  it('waits for a concurrent reversal (wallet row lock) and then rejects, without a new OrderPaidV1', async () => {
    const { orderId, transactionId } = await paidOrder();
    const customer = (
      await h.db
        .withSchema(schema(h.acme))
        .selectFrom('order_payments')
        .select('customer_id')
        .where('order_id', '=', orderId)
        .executeTakeFirstOrThrow()
    ).customer_id;
    const before = (await outboxFor(orderId)).length;
    // Giữ khóa hàng ví từ một transaction thô: giả lập ReverseTransaction đang giữ ví (ORDER_PAYMENT).
    const { release, done: hold } = await holdWalletLock(h, h.acme, customer);

    // Số yêu cầu đang bị chặn trong DB (đọc từ DMV, không dùng sleep cố định để quyết định đậu/rớt).
    const blockedCount = () => blockedRequestCount(h);
    const waitBlocked = async (atLeast: number, stop: () => boolean): Promise<void> => {
      const deadline = Date.now() + 15000;
      while (!stop() && Date.now() < deadline && (await blockedCount()) < atLeast) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    const reversal = reverse.execute({
      tenant: h.acme,
      transactionId,
      actor: 'op@x',
      reason: 'refund',
      idempotencyKey: `rp-race-${++counter}`,
    });
    // Đảo xếp hàng chờ khóa ví TRƯỚC, rồi mới phát lại: nếu phát lại cũng xếp hàng phía sau thì nó sẽ thấy giao dịch đảo.
    await waitBlocked(1, () => false);
    const reversalBlocked = await blockedCount();
    if (reversalBlocked < 1) release();
    expect(reversalBlocked).toBeGreaterThanOrEqual(1);
    let replaySettled = false;
    const replaying = replay
      .execute(request(orderId))
      .then(
        () => 'resolved' as const,
        (error: unknown) => error,
      )
      .finally(() => {
        replaySettled = true;
      });

    // Chờ (có hạn) cho tới khi cả hai yêu cầu cùng bị chặn trong DB, hoặc replay đã xong sớm (tức là không bị khóa).
    await waitBlocked(2, () => replaySettled);
    const stillPending = !replaySettled;
    release();
    await hold;
    expect(stillPending).toBe(true);
    await reversal;
    expect(await replaying).toBeInstanceOf(OrderReversedError);
    expect(await outboxFor(orderId)).toHaveLength(before);
  });
});
