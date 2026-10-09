import { verifyWebhook } from '@billing/contracts';
import { WebhookReceiver } from '@billing/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createWebhookSender, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { DeliverDueWebhooks } from './deliver-due-webhooks.js';

const secret = 'test-secret';
const T0 = '2026-10-09T10:00:00.000Z';

let h: Harness;
let receiver: WebhookReceiver;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let deliver: DeliverDueWebhooks;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set(T0);
  receiver = await WebhookReceiver.start();
  deliver = new DeliverDueWebhooks({
    uow: h.uow,
    sender: createWebhookSender(receiver.url, secret),
    clock: h.clock,
    backoffSeconds: [1, 5],
    leaseSeconds: 60,
  });
});
afterEach(async () => {
  await receiver.close();
});

/** Tạo charge rồi hoàn tất nó, để lại một webhook_event PENDING đến hạn ngay. */
async function seed(key: string, simulate?: string): Promise<void> {
  await createCharge.execute({
    idempotencyKey: key,
    amount: 1000,
    currency: 'VND',
    reference: `ref-${key}`,
    simulate,
  });
  await completeDue.execute();
}
const events = () => h.db.selectFrom('webhook_events').selectAll().orderBy('event_id').execute();
const attempts = () =>
  h.db
    .selectFrom('webhook_attempts')
    .selectAll()
    .orderBy('event_id')
    .orderBy('attempt_no')
    .execute();
const plus = (seconds: number) => new Date(new Date(T0).getTime() + seconds * 1000);

describe('DeliverDueWebhooks', () => {
  it('does nothing when no event is due', async () => {
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(receiver.received).toHaveLength(0);
  });

  it('delivers a due event with a valid signature and records the attempt', async () => {
    await seed('a');
    expect(await deliver.execute()).toEqual({ delivered: 1, retrying: 0, failed: 0 });

    const [request] = receiver.received;
    expect(
      verifyWebhook({
        secret,
        body: request?.body ?? '',
        header: request?.headers['x-signature'] as string,
        nowSeconds: Math.floor(h.clock.now().getTime() / 1000),
      }),
    ).toEqual({ ok: true });

    const [event] = await events();
    expect(event).toMatchObject({ status: 'DELIVERED', attempts: 1, next_attempt_at: null });
    expect(event?.delivered_at).toEqual(h.clock.now());
    expect(await attempts()).toMatchObject([
      { attempt_no: 1, status_code: 200, error_message: null },
    ]);
  });

  it('retries on the backoff schedule, then gives up and keeps the event as FAILED', async () => {
    receiver.setDefaultStatus(500);
    await seed('a');

    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    let [event] = await events();
    expect(event).toMatchObject({ status: 'PENDING', attempts: 1, next_attempt_at: plus(1) });

    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(receiver.received).toHaveLength(1);

    h.clock.advanceSeconds(1);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    [event] = await events();
    expect(event).toMatchObject({ status: 'PENDING', attempts: 2, next_attempt_at: plus(6) });

    h.clock.advanceSeconds(5);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 1 });
    [event] = await events();
    expect(event).toMatchObject({ status: 'FAILED', attempts: 3, next_attempt_at: null });
    expect(receiver.received).toHaveLength(3);
    expect(await attempts()).toMatchObject([
      { attempt_no: 1, status_code: 500, error_message: 'HTTP 500' },
      { attempt_no: 2, status_code: 500, error_message: 'HTTP 500' },
      { attempt_no: 3, status_code: 500, error_message: 'HTTP 500' },
    ]);

    h.clock.advanceSeconds(10_000);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(receiver.received).toHaveLength(3);
  });

  it('delivers on a later attempt once the receiver recovers', async () => {
    receiver.respondWith(500);
    await seed('a');
    expect(await deliver.execute()).toMatchObject({ retrying: 1 });
    h.clock.advanceSeconds(1);
    expect(await deliver.execute()).toMatchObject({ delivered: 1 });
    const [event] = await events();
    expect(event).toMatchObject({ status: 'DELIVERED', attempts: 2 });
  });

  it('sends the same event twice for webhook=duplicate but counts one attempt', async () => {
    await seed('a', 'webhook=duplicate');
    expect(await deliver.execute()).toMatchObject({ delivered: 1 });
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[0]?.body).toBe(receiver.received[1]?.body);
    expect(receiver.received[0]?.headers['x-webhook-event-id']).toBe(
      receiver.received[1]?.headers['x-webhook-event-id'],
    );
    expect(await attempts()).toHaveLength(1);
  });

  it('records a connection failure and schedules a retry', async () => {
    await seed('a');
    await receiver.close();
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    const [attempt] = await attempts();
    expect(attempt?.status_code).toBeNull();
    expect(attempt?.error_message).toBeTruthy();
  });

  it('does not redeliver an event that is leased until the lease expires (crash recovery)', async () => {
    await seed('a');
    await h.uow.run(async ({ webhooks }) => {
      const [claimed] = await webhooks.lockDue(h.clock.now(), 10);
      if (!claimed) throw new Error('expected a due event');
      await webhooks.save(claimed.claim(h.clock.now(), 60));
    });

    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    h.clock.advanceSeconds(59);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    h.clock.advanceSeconds(1);
    expect(await deliver.execute()).toMatchObject({ delivered: 1 });
  });

  it('honours the limit', async () => {
    for (const key of ['a', 'b', 'c']) await seed(key);
    expect(await deliver.execute(2)).toMatchObject({ delivered: 2 });
    expect(await deliver.execute(2)).toMatchObject({ delivered: 1 });
  });
});
