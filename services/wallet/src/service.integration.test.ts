import { signWebhook } from '@billing/contracts';
import { createDatabase } from '@billing/database';
import {
  FakeClock,
  FakePaymentServer,
  createTestBroker,
  createTestDatabase,
  waitFor,
  type TestBroker,
  type TestDatabase,
} from '@billing/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startService, type RunningService } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { TenantId } from './domain/tenant-id.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';

const SECRET = 'whsec_service_e2e';
const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');

let testDb: TestDatabase;
let broker: TestBroker;
let db: Kysely<WalletDatabase>;
let fake: FakePaymentServer;
let clock: FakeClock;
const running: RunningService[] = [];
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase('walletsvc');
  broker = await createTestBroker('walletsvc');
  db = createDatabase<WalletDatabase>(testDb.config);
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
  await broker.drop();
});
beforeEach(async () => {
  fake = await FakePaymentServer.start();
  clock = new FakeClock('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await fake.close();
  // Database dùng chung giữa các test: một lần nạp còn REQUESTED sẽ bị worker của test sau nhặt nhầm.
  for (const schema of ['t_acme', 't_beta']) {
    await db
      .withSchema(schema)
      .updateTable('topups')
      .set({ status: 'FAILED', failure_code: 'TEST_CLEANUP', next_attempt_at: null })
      .where('status', '=', 'REQUESTED')
      .execute();
  }
});

const configFor = (overrides: Partial<WalletConfig> = {}): WalletConfig => ({
  port: 0,
  database: testDb.config,
  tenants: [acme, beta],
  payment: { baseUrl: fake.baseUrl, webhookSecret: SECRET, timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  topupBackoffSeconds: [1, 5],
  workerIntervalMs: 20,
  ...overrides,
});

async function start(overrides: Partial<WalletConfig> = {}): Promise<RunningService> {
  const service = await startService(configFor(overrides), { clock });
  running.push(service);
  return service;
}

const callerHeaders = (tenant: string, customer: string) => ({
  'x-tenant-id': tenant,
  'x-customer-id': customer,
});
const newCustomer = () => `svc${++counter}`;

async function openWallet(
  service: RunningService,
  customer: string,
  tenant = 'acme',
): Promise<void> {
  const res = await service.app.inject({
    method: 'POST',
    url: '/wallets',
    headers: callerHeaders(tenant, customer),
    payload: { currency: 'VND' },
  });
  expect(res.statusCode).toBe(201);
}

async function requestTopup(
  service: RunningService,
  customer: string,
  { tenant = 'acme', amount = 150000, key = 'key-1' } = {},
): Promise<string> {
  const res = await service.app.inject({
    method: 'POST',
    url: '/topups',
    headers: { ...callerHeaders(tenant, customer), 'idempotency-key': key },
    payload: { amount },
  });
  expect(res.statusCode).toBe(202);
  return res.json<{ topupId: string }>().topupId;
}

const rowOf = (tenant: string, topupId: string) =>
  db
    .withSchema(`t_${tenant}`)
    .selectFrom('topups')
    .selectAll()
    .where('id', '=', topupId)
    .executeTakeFirstOrThrow();
const statusOf = async (topupId: string, tenant = 'acme') => (await rowOf(tenant, topupId)).status;
const attemptsOf = async (topupId: string, tenant = 'acme') =>
  Number((await rowOf(tenant, topupId)).attempts);

/** Gửi webhook đã ký như payment sẽ làm. */
function settle(
  service: RunningService,
  topupId: string,
  chargeId: string,
  tenant = 'acme',
  amount = 150000,
) {
  const now = clock.now().toISOString();
  const raw = JSON.stringify({
    eventId: `evt_svc_${++counter}`,
    type: 'charge.succeeded',
    createdAt: now,
    data: {
      chargeId,
      reference: topupId,
      amount,
      currency: 'VND',
      status: 'SUCCEEDED',
      completedAt: now,
      metadata: { tenantId: tenant },
    },
  });
  return service.app.inject({
    method: 'POST',
    url: '/webhooks/payment',
    headers: {
      'content-type': 'application/json',
      'x-signature': signWebhook(SECRET, raw, Math.floor(clock.now().getTime() / 1000)),
    },
    payload: raw,
  });
}

const walletOf = async (service: RunningService, customer: string, tenant = 'acme') =>
  (
    await service.app.inject({
      method: 'GET',
      url: '/wallet',
      headers: callerHeaders(tenant, customer),
    })
  ).json<{
    balance: number;
  }>();

describe('wallet service, end to end with a scripted payment', () => {
  it('sends the charge right after accepting the topup, then settles it from the signed webhook', async () => {
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await statusOf(topupId)) === 'PENDING');
    expect(fake.requests).toHaveLength(1);
    const [sent] = fake.requests;
    expect(sent).toMatchObject({ method: 'POST', url: '/charges' });
    expect(sent?.headers['idempotency-key']).toBe(`topup:acme:${topupId}`);
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      amount: 150000,
      currency: 'VND',
      reference: topupId,
      metadata: { tenantId: 'acme' },
    });
    expect((await walletOf(service, customer)).balance).toBe(0);

    expect((await settle(service, topupId, 'ch_fake_1')).statusCode).toBe(200);
    expect(await statusOf(topupId)).toBe('SUCCEEDED');
    expect((await walletOf(service, customer)).balance).toBe(150000);

    const entries = await service.app.inject({
      method: 'GET',
      url: '/wallet/entries',
      headers: callerHeaders('acme', customer),
    });
    expect(entries.json<{ items: Array<{ businessKey: string; amount: number }> }>().items).toEqual(
      [expect.objectContaining({ businessKey: `topup:${topupId}`, amount: 150000 })],
    );
    expect(fake.requests).toHaveLength(1);
  });

  it('retries on the backoff schedule with the same idempotency key until payment recovers', async () => {
    fake.enqueue({ status: 503 }, { status: 503 });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    // Đợi lần thất bại được ghi xong rồi mới tiến đồng hồ (nếu không `next_attempt_at` bị tính từ giờ mới).
    await waitFor(async () => (await attemptsOf(topupId)) === 1);
    expect(await statusOf(topupId)).toBe('REQUESTED');
    clock.advanceSeconds(1);
    await waitFor(async () => (await attemptsOf(topupId)) === 2);
    clock.advanceSeconds(5);
    await waitFor(async () => (await statusOf(topupId)) === 'PENDING');

    expect(fake.requests).toHaveLength(3);
    expect(new Set(fake.requests.map((r) => r.headers['idempotency-key'])).size).toBe(1);
    expect(await attemptsOf(topupId)).toBe(3);
  });

  it('does not retry before the backoff has elapsed', async () => {
    fake.enqueue({ status: 503 });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);
    await waitFor(async () => (await attemptsOf(topupId)) === 1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    clock.advanceSeconds(0.5);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.requests).toHaveLength(1);
    expect(await statusOf(topupId)).toBe('REQUESTED');
  });

  it('fails the topup at once when payment rejects the request, and never retries it', async () => {
    fake.enqueue({
      status: 422,
      body: { error: { code: 'INVALID_REQUEST', message: 'bad amount' } },
    });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await statusOf(topupId)) === 'FAILED');
    const res = await service.app.inject({
      method: 'GET',
      url: `/topups/${topupId}`,
      headers: callerHeaders('acme', customer),
    });
    expect(res.json()).toMatchObject({ status: 'FAILED', failureCode: 'PAYMENT_REJECTED' });
    clock.advanceSeconds(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.requests).toHaveLength(1);
  });

  it('gives up with PAYMENT_UNAVAILABLE once the backoff list is exhausted, yet a later webhook still credits the wallet', async () => {
    fake.setFallback(() => ({ status: 503 }));
    const service = await start({ topupBackoffSeconds: [1] });
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await attemptsOf(topupId)) === 1);
    clock.advanceSeconds(1);
    await waitFor(async () => (await statusOf(topupId)) === 'FAILED');
    expect((await rowOf('acme', topupId)).failure_code).toBe('PAYMENT_UNAVAILABLE');
    expect((await walletOf(service, customer)).balance).toBe(0);

    // Payment thực ra đã nhận charge (ví dụ ở lần timeout); webhook thành công đến muộn.
    expect((await settle(service, topupId, 'ch_late')).statusCode).toBe(200);
    expect(await statusOf(topupId)).toBe('SUCCEEDED');
    expect((await walletOf(service, customer)).balance).toBe(150000);
  });

  it('treats a payment that is too slow as unavailable, then retries with the same key', async () => {
    fake.enqueue({ status: 202, body: { chargeId: 'ch_slow' }, delayMs: 400 });
    const service = await start({
      payment: { baseUrl: fake.baseUrl, webhookSecret: SECRET, timeoutMs: 100 },
    });
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await attemptsOf(topupId)) === 1);
    expect(await statusOf(topupId)).toBe('REQUESTED');
    clock.advanceSeconds(1);
    await waitFor(async () => (await statusOf(topupId)) === 'PENDING');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.headers['idempotency-key']).toBe(
      fake.requests[1]?.headers['idempotency-key'],
    );
  });

  it('serves every configured tenant from one worker, sending each tenant id to payment', async () => {
    fake.enqueue({ status: 503 }, { status: 503 });
    const service = await start();
    const inAcme = newCustomer();
    const inBeta = newCustomer();
    await openWallet(service, inAcme, 'acme');
    await openWallet(service, inBeta, 'beta');
    const acmeTopup = await requestTopup(service, inAcme, { tenant: 'acme' });
    const betaTopup = await requestTopup(service, inBeta, { tenant: 'beta' });

    await waitFor(
      async () =>
        (await attemptsOf(acmeTopup)) === 1 && (await attemptsOf(betaTopup, 'beta')) === 1,
    );
    clock.advanceSeconds(1);
    await waitFor(
      async () =>
        (await statusOf(acmeTopup)) === 'PENDING' &&
        (await statusOf(betaTopup, 'beta')) === 'PENDING',
    );
    const lastTwo = fake.requests
      .slice(-2)
      .map((r) => (JSON.parse(r.body) as { metadata: { tenantId: string } }).metadata.tenantId);
    expect(lastTwo.sort()).toEqual(['acme', 'beta']);
  });

  it('lets an in-flight inline submission finish before it closes the database on stop()', async () => {
    fake.enqueue({ status: 202, body: { chargeId: 'ch_inflight' }, delayMs: 300 });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);
    await waitFor(() => fake.requests.length === 1);

    await service.stop();
    expect(await rowOf('acme', topupId)).toMatchObject({
      status: 'PENDING',
      charge_id: 'ch_inflight',
    });
  });

  it('stop() can be called more than once, concurrently', async () => {
    const service = await start();
    await expect(Promise.all([service.stop(), service.stop()])).resolves.toBeDefined();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('refuses to start when a configured tenant has not been migrated, naming the tenant', async () => {
    const bare = await createTestDatabase('walletbare');
    try {
      await expect(
        startService({ ...configFor(), database: bare.config }, { clock }),
      ).rejects.toThrow(/not migrated.*"acme".*001-ledger/);
    } finally {
      await bare.drop();
    }
  });
});
