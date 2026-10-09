import { createDatabase, migrate } from '@billing/database';
import { validateChargeWebhook, verifyWebhook } from '@billing/contracts';
import { WebhookReceiver, createTestDatabase, waitFor, type TestDatabase } from '@billing/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentMigrations } from '../../../db/payment/migrations.js';
import { startService, type RunningService } from './bootstrap.js';
import type { PaymentConfig } from './config.js';

const secret = 'whsec_e2e';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let testDb: TestDatabase;
let receiver: WebhookReceiver;
const running: RunningService[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase('service');
  const db = createDatabase<unknown>(testDb.config);
  await migrate(db, paymentMigrations);
  await db.destroy();
});
afterAll(async () => {
  await testDb.drop();
});
beforeEach(async () => {
  receiver = await WebhookReceiver.start();
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await receiver.close();
});

function configFor(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    port: 0,
    database: testDb.config,
    webhook: { url: receiver.url, secret, backoffSeconds: [1] },
    workerIntervalMs: 20,
    responseTimeoutMs: 150,
    ...overrides,
  };
}

async function start(overrides: Partial<PaymentConfig> = {}): Promise<RunningService> {
  const service = await startService(configFor(overrides));
  running.push(service);
  return service;
}

function post(
  service: RunningService,
  key: string,
  payload: object,
  headers: Record<string, string> = {},
) {
  return service.app.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers },
    payload: JSON.stringify(payload),
  });
}

const body = (reference: string) => ({ amount: 150000, currency: 'VND', reference });
const today = () => new Date().toISOString().slice(0, 10);

describe('payment service, end to end', () => {
  it('accepts a charge, completes it in the background and delivers a signed webhook', async () => {
    const service = await start();
    const res = await post(service, 'e2e-ok', body('topup-ok'));
    expect(res.statusCode).toBe(202);
    const { chargeId } = res.json();
    expect(res.json().status).toBe('PENDING');

    await waitFor(() => receiver.received.length >= 1);
    const [request] = receiver.received;
    expect(
      verifyWebhook({
        secret,
        body: request?.body ?? '',
        header: request?.headers['x-signature'] as string,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toEqual({ ok: true });
    const parsed = validateChargeWebhook(JSON.parse(request?.body ?? ''));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.payload).toMatchObject({
      type: 'charge.succeeded',
      data: {
        chargeId,
        reference: 'topup-ok',
        amount: 150000,
        currency: 'VND',
        status: 'SUCCEEDED',
      },
    });

    const charge = await service.app.inject({ method: 'GET', url: `/charges/${chargeId}` });
    expect(charge.json()).toMatchObject({ chargeId, status: 'SUCCEEDED' });

    const settlement = await service.app.inject({
      method: 'GET',
      url: `/settlements?date=${today()}`,
    });
    expect(settlement.statusCode).toBe(200);
    expect(settlement.json().items).toContainEqual(
      expect.objectContaining({ chargeId, status: 'SUCCEEDED' }),
    );
    expect(settlement.json().totals).toContainEqual(
      expect.objectContaining({ currency: 'VND', status: 'SUCCEEDED' }),
    );
  });

  it('reports a declined card through charge.failed', async () => {
    const service = await start();
    const res = await post(service, 'e2e-fail', body('topup-fail'), {
      'x-simulate': 'fail=card_declined',
    });
    await waitFor(() => receiver.received.length >= 1);
    const payload = JSON.parse(receiver.received[0]?.body ?? '');
    expect(payload).toMatchObject({
      type: 'charge.failed',
      data: { chargeId: res.json().chargeId, status: 'FAILED', failureCode: 'card_declined' },
    });
  });

  it('completes a webhook=drop charge but never sends a webhook (the lost-webhook case)', async () => {
    const service = await start();
    const res = await post(service, 'e2e-drop', body('topup-drop'), {
      'x-simulate': 'webhook=drop',
    });
    await waitFor(async () => {
      const charge = await service.app.inject({
        method: 'GET',
        url: `/charges/${res.json().chargeId}`,
      });
      return charge.json().status === 'SUCCEEDED';
    });
    await sleep(200);
    expect(receiver.received).toHaveLength(0);
  });

  it('retries a failing receiver after the backoff', async () => {
    receiver.respondWith(500);
    const service = await start();
    await post(service, 'e2e-retry', body('topup-retry'));
    await waitFor(() => receiver.received.length >= 2, { timeoutMs: 8000 });
    expect(receiver.received[0]?.body).toBe(receiver.received[1]?.body);
  });

  it('holds the first response of response=timeout but answers the replay immediately', async () => {
    const service = await start();
    const startedFirst = Date.now();
    const first = await post(service, 'e2e-timeout', body('topup-timeout'), {
      'x-simulate': 'response=timeout',
    });
    const firstMs = Date.now() - startedFirst;

    const startedReplay = Date.now();
    const replay = await post(service, 'e2e-timeout', body('topup-timeout'), {
      'x-simulate': 'response=timeout',
    });
    const replayMs = Date.now() - startedReplay;

    expect(first.statusCode).toBe(202);
    expect(firstMs).toBeGreaterThanOrEqual(130);
    expect(replay.json()).toEqual(first.json());
    expect(replayMs).toBeLessThan(firstMs);
  });

  it('answers 422 when a key is reused with different content', async () => {
    const service = await start();
    await post(service, 'e2e-reuse', body('a'));
    const conflict = await post(service, 'e2e-reuse', body('b'));
    expect(conflict.statusCode).toBe(422);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keeps its state across a restart and still delivers the pending webhook', async () => {
    // Instance A: chu kỳ worker rất dài nên nó nhận charge nhưng không kịp hoàn tất.
    const before = await start({ workerIntervalMs: 60_000 });
    // Tick đầu của worker chạy ngay khi start(); chờ nó xong để nó không nhặt charge sắp tạo.
    await sleep(500);
    const res = await post(before, 'e2e-restart', body('topup-restart'));
    expect(res.statusCode).toBe(202);
    await running.pop()?.stop();
    // Database dùng chung giữa các test nên webhook tồn đọng của test trước có thể được gửi ở đây;
    // chỉ xét webhook của charge này.
    const deliveredFor = (chargeId: string) =>
      receiver.received.filter((r) => (r.body ?? '').includes(chargeId));
    const { chargeId } = res.json();
    expect(deliveredFor(chargeId)).toHaveLength(0);

    // Instance B dùng cùng database: phải tự hoàn tất charge và gửi webhook.
    await start({ workerIntervalMs: 20 });
    await waitFor(() => deliveredFor(chargeId).length >= 1);
    expect(JSON.parse(deliveredFor(chargeId)[0]?.body ?? '')).toMatchObject({
      type: 'charge.succeeded',
      data: { chargeId },
    });
  });
});
