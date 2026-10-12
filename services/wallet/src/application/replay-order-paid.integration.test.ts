import { randomUUID } from 'node:crypto';
import { validateEvent } from '@billing/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import { RecordingMetrics } from '../test-support-metrics.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
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

/** Tạo một đơn đã trả và mô phỏng dòng `order_payments` sau Task 7 bằng cách gán `paid_event_id` thật. */
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
  if (withEventId) {
    await h.db
      .withSchema(schema(h.acme))
      .updateTable('order_payments')
      .set({ paid_event_id: paidEventId })
      .where('order_id', '=', orderId)
      .execute();
  }
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
});
