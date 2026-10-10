import { signWebhook } from '@billing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { CreateWallet } from '../../application/create-wallet.js';
import { GetTopup } from '../../application/get-topup.js';
import { GetWallet } from '../../application/get-wallet.js';
import { ListEntries } from '../../application/list-entries.js';
import type { Logger, TopupSubmitter } from '../../application/ports.js';
import { RequestTopup } from '../../application/request-topup.js';
import type { TenantId } from '../../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  type Harness,
} from '../../test-support.js';
import type { AppDeps } from '../../app.module.js';
import { createApp } from './create-app.js';

const SECRET = 'whsec_test_secret_value';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let h: Harness;
let app: NestFastifyApplication;
let logs: Array<{ level: string; details: object; message: string | undefined }>;
let submitted: Array<{ tenant: string; topupId: string }>;
let counter = 0;

const log = (): Logger => ({
  info: (details, message) => logs.push({ level: 'info', details, message }),
  warn: (details, message) => logs.push({ level: 'warn', details, message }),
  error: (details, message) => logs.push({ level: 'error', details, message }),
});

function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const logger = log();
  const submitter: TopupSubmitter = {
    submitSoon: (tenant: TenantId, topupId: string) =>
      submitted.push({ tenant: tenant.value, topupId }),
  };
  return {
    registry: h.registry,
    clock: h.clock,
    log: logger,
    webhookSecret: SECRET,
    createWallet: new CreateWallet({ uow: h.uow, clock: h.clock }),
    getWallet: new GetWallet({ uow: h.uow }),
    listEntries: new ListEntries({ uow: h.uow }),
    requestTopup: new RequestTopup({ uow: h.uow, clock: h.clock, ids: h.ids, submitter }),
    getTopup: new GetTopup({ uow: h.uow }),
    applyPaymentResult: new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: logger,
    }),
    startReconciliation: { execute: () => Promise.reject(new Error('not used')) },
    getReconciliationRun: { execute: () => Promise.reject(new Error('not used')) },
    listReconciliationItems: { execute: () => Promise.reject(new Error('not used')) },
    resolveReconciliationItem: { execute: () => Promise.reject(new Error('not used')) },
    ...overrides,
  };
}

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  logs = [];
  submitted = [];
  h.clock.set('2026-10-10T10:00:00.000Z');
  app = await createApp(buildDeps());
});
afterEach(async () => {
  await app.close();
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const who = (tenant: string | undefined, customer: string | undefined): Record<string, string> => ({
  ...(tenant === undefined ? {} : { 'x-tenant-id': tenant }),
  ...(customer === undefined ? {} : { 'x-customer-id': customer }),
});
const newCustomer = () => `api${++counter}`;
const errorOf = (body: string): { code: string; message: string } =>
  (JSON.parse(body) as { error: { code: string; message: string } }).error;

async function createWallet(customer: string, currency = 'VND', tenant = 'acme') {
  return app.inject({
    method: 'POST',
    url: '/wallets',
    headers: who(tenant, customer),
    payload: { currency },
  });
}

describe('cross-cutting behaviour', () => {
  it('serves /health without tenant headers and stamps a correlation id on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'wallet' });
    expect(res.headers['x-correlation-id']).toMatch(UUID);
  });

  it('reuses a valid incoming correlation id, also on error responses', async () => {
    const id = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const res = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: { 'x-correlation-id': id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-correlation-id']).toBe(id);
  });

  it('answers unknown routes and malformed JSON with the standard error envelope', async () => {
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('NOT_FOUND');

    const bad = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { ...who('acme', newCustomer()), 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.body).code).toBe('INVALID_REQUEST');
  });

  it('turns an unexpected failure into 500 INTERNAL without leaking the cause, and logs it', async () => {
    const broken = await createApp(
      buildDeps({
        getWallet: {
          execute: () => {
            throw new Error('secret detail: connection string xyz');
          },
        },
      }),
    );
    const res = await broken.inject({
      method: 'GET',
      url: '/wallet',
      headers: who('acme', newCustomer()),
    });
    await broken.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(res.body).not.toContain('secret detail');
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });
});

describe('tenant and customer headers', () => {
  it.each([
    ['no tenant header', undefined, 'c1', 400, 'MISSING_TENANT'],
    ['a blank tenant header', '  ', 'c1', 400, 'MISSING_TENANT'],
    ['a tenant that is not configured', 'ghost', 'c1', 403, 'UNKNOWN_TENANT'],
    ['a tenant with a bad shape', 'Acme', 'c1', 403, 'UNKNOWN_TENANT'],
    ['a tenant trying to escape the schema', 't_acme]; drop', 'c1', 403, 'UNKNOWN_TENANT'],
    ['no customer header', 'acme', undefined, 400, 'MISSING_CUSTOMER'],
    ['a customer with a bad shape', 'acme', 'a b', 400, 'INVALID_REQUEST'],
    ['a customer that is too long', 'acme', 'x'.repeat(65), 400, 'INVALID_REQUEST'],
  ])('rejects %s', async (_name, tenant, customer, status, code) => {
    const res = await app.inject({ method: 'GET', url: '/wallet', headers: who(tenant, customer) });
    expect(res.statusCode).toBe(status);
    expect(errorOf(res.body).code).toBe(code);
  });

  it('ignores a tenant or customer given in the body or the query', async () => {
    const customer = newCustomer();
    const created = await app.inject({
      method: 'POST',
      url: '/wallets?tenantId=beta&customerId=evil',
      headers: who('acme', customer),
      payload: { currency: 'VND', tenantId: 'beta', customerId: 'evil' },
    });
    expect(created.statusCode).toBe(201);
    expect(
      (await app.inject({ method: 'GET', url: '/wallet', headers: who('acme', customer) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/wallet', headers: who('beta', customer) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/wallet', headers: who('acme', 'evil') }))
        .statusCode,
    ).toBe(404);
  });
});

describe('wallets', () => {
  it('POST /wallets creates (201), repeats (200) and refuses another currency (409)', async () => {
    const customer = newCustomer();
    const first = await createWallet(customer, 'VND');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({
      customerId: customer,
      currency: 'VND',
      balance: 0,
      createdAt: '2026-10-10T10:00:00.000Z',
    });
    const again = await createWallet(customer, 'VND');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const conflict = await createWallet(customer, 'USD');
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict.body).code).toBe('WALLET_CURRENCY_CONFLICT');
  });

  it.each([
    ['an unsupported currency', { currency: 'EUR' }],
    ['a numeric currency', { currency: 5 }],
    ['a missing currency', {}],
    ['an array body', [{ currency: 'VND' }]],
  ])('POST /wallets rejects %s with 400 INVALID_REQUEST', async (_name, payload) => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: who('acme', newCustomer()),
      payload: payload as object,
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_REQUEST');
  });

  it('POST /wallets without any body is a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: who('acme', newCustomer()),
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_REQUEST');
  });

  it('GET /wallet answers 404 WALLET_NOT_FOUND, then the wallet', async () => {
    const customer = newCustomer();
    const missing = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: who('acme', customer),
    });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('WALLET_NOT_FOUND');
    await createWallet(customer, 'USD');
    const found = await app.inject({
      method: 'GET',
      url: '/wallet',
      headers: who('acme', customer),
    });
    expect(found.json()).toMatchObject({ customerId: customer, currency: 'USD', balance: 0 });
  });
});

describe('POST /topups and GET /topups/:id', () => {
  const post = (customer: string, key: string | undefined, payload: unknown, tenant = 'acme') =>
    app.inject({
      method: 'POST',
      url: '/topups',
      headers: {
        ...who(tenant, customer),
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      payload: payload as object,
    });

  it('accepts a topup with 202 REQUESTED and triggers one submission', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const res = await post(customer, 'key-1', { amount: 150000 });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ topupId: string }>();
    expect(body).toEqual({
      topupId: expect.stringMatching(/^tp_/),
      status: 'REQUESTED',
      amount: 150000,
      currency: 'VND',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
    expect(submitted).toEqual([{ tenant: 'acme', topupId: body.topupId }]);
  });

  it('accepts exactly 1_000_000_000_000 and rejects one more with 400 INVALID_REQUEST', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    expect((await post(customer, 'max-ok', { amount: 1_000_000_000_000 })).statusCode).toBe(202);
    const tooBig = await post(customer, 'max-over', { amount: 1_000_000_000_001 });
    expect(tooBig.statusCode).toBe(400);
    expect(errorOf(tooBig.body).code).toBe('INVALID_REQUEST');
  });

  it('replays the stored response for the same key and body, and rejects reuse with another body', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const first = await post(customer, 'key-1', { amount: 500 });
    const replay = await post(customer, 'key-1', { amount: 500 });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(submitted).toHaveLength(1);
    const reused = await post(customer, 'key-1', { amount: 501 });
    expect(reused.statusCode).toBe(422);
    expect(errorOf(reused.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires a well-formed Idempotency-Key', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const missing = await post(customer, undefined, { amount: 10 });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing.body).code).toBe('MISSING_IDEMPOTENCY_KEY');
    for (const key of ['', ' padded', 'padded ', 'k'.repeat(256)]) {
      const res = await post(customer, key, { amount: 10 });
      expect(res.statusCode, `key ${JSON.stringify(key)}`).toBe(400);
      expect(errorOf(res.body).code).toBe(
        key === '' ? 'MISSING_IDEMPOTENCY_KEY' : 'INVALID_IDEMPOTENCY_KEY',
      );
    }
    expect((await post(customer, 'k'.repeat(255), { amount: 10 })).statusCode).toBe(202);
  });

  it.each([
    ['zero', { amount: 0 }],
    ['negative', { amount: -5 }],
    ['fractional', { amount: 10.5 }],
    ['a string', { amount: '100' }],
    ['missing', {}],
    ['null', { amount: null }],
  ])('rejects an amount that is %s with 400 INVALID_REQUEST', async (_name, payload) => {
    const customer = newCustomer();
    await createWallet(customer);
    const res = await post(customer, `key-${_name}`, payload);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_REQUEST');
    expect(submitted).toHaveLength(0);
  });

  it('answers 404 WALLET_NOT_FOUND when there is no wallet, and never uses a currency from the body', async () => {
    const missing = await post(newCustomer(), 'key-1', { amount: 10 });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('WALLET_NOT_FOUND');

    const customer = newCustomer();
    await createWallet(customer, 'VND');
    const res = await post(customer, 'key-1', { amount: 10, currency: 'USD' });
    expect(res.json()).toMatchObject({ currency: 'VND' });
  });

  it('shows a topup to its owner only: not to another customer, not to another tenant', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const { topupId } = (await post(customer, 'key-1', { amount: 900 })).json<{
      topupId: string;
    }>();
    const get = (tenant: string, who_: string) =>
      app.inject({ method: 'GET', url: `/topups/${topupId}`, headers: who(tenant, who_) });

    const own = await get('acme', customer);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toStrictEqual({
      topupId,
      status: 'REQUESTED',
      amount: 900,
      currency: 'VND',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
    for (const other of [get('acme', newCustomer()), get('beta', customer)]) {
      const res = await other;
      expect(res.statusCode).toBe(404);
      expect(errorOf(res.body).code).toBe('TOPUP_NOT_FOUND');
    }
  });
});

describe('GET /wallet/entries', () => {
  /** Tạo ví rồi nạp thật `count` lần (100, 200, 300…) qua `ApplyPaymentResult` để sổ cái và số dư luôn khớp nhau. */
  async function walletWithEntries(count: number): Promise<string> {
    const customer = newCustomer();
    await createWallet(customer);
    const { applyPaymentResult } = buildDeps();
    for (let i = 0; i < count; i++) {
      const seeded = await seedTopup(h, { customer, amount: 100 * (i + 1) });
      await applyPaymentResult.execute({
        tenant: h.acme,
        eventId: `evt_entries_${customer}_${i}`,
        type: 'charge.succeeded',
        chargeId: seeded.chargeId,
        reference: seeded.topupId,
        amount: seeded.amount,
        currency: seeded.currency,
      });
    }
    return customer;
  }
  const list = (customer: string, query = '') =>
    app.inject({ method: 'GET', url: `/wallet/entries${query}`, headers: who('acme', customer) });

  it('pages through the entries in order with a cursor', async () => {
    const customer = await walletWithEntries(3);
    const first = (await list(customer, '?limit=2')).json<{
      items: Array<{ businessKey: string; amount: number }>;
      nextCursor: string | null;
    }>();
    expect(first.items.map((i) => i.amount)).toEqual([100, 200]);
    expect(first.nextCursor).toMatch(/^\d+$/);
    const second = (await list(customer, `?limit=2&cursor=${first.nextCursor}`)).json<{
      items: Array<{ amount: number }>;
      nextCursor: string | null;
    }>();
    expect(second.items.map((i) => i.amount)).toEqual([300]);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    '?limit=0',
    '?limit=1001',
    '?limit=abc',
    '?limit=1.5',
    '?limit=1&limit=2',
    '?cursor=abc',
    '?cursor=-1',
  ])('rejects the query %s with 400 INVALID_QUERY', async (query) => {
    const customer = await walletWithEntries(1);
    const res = await list(customer, query);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_QUERY');
  });

  it('answers 404 WALLET_NOT_FOUND for a customer without a wallet', async () => {
    const res = await list(newCustomer());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe('WALLET_NOT_FOUND');
  });
});

describe('POST /webhooks/payment', () => {
  const nowSeconds = () => Math.floor(h.clock.now().getTime() / 1000);
  const iso = () => h.clock.now().toISOString();

  /** Thân webhook cố ý có khoảng trắng và thụt lề để chứng minh chữ ký được kiểm trên thân thô. */
  const body = (
    seeded: { topupId: string; chargeId: string; amount: number; currency: string },
    overrides: Record<string, unknown> = {},
    data: Record<string, unknown> = {},
  ) =>
    JSON.stringify(
      {
        eventId: `evt_api_${++counter}`,
        type: 'charge.succeeded',
        createdAt: iso(),
        data: {
          chargeId: seeded.chargeId,
          reference: seeded.topupId,
          amount: seeded.amount,
          currency: seeded.currency,
          status: 'SUCCEEDED',
          completedAt: iso(),
          metadata: { tenantId: 'acme' },
          ...data,
        },
        ...overrides,
      },
      null,
      2,
    );

  /** `signature = null` nghĩa là không gửi header chữ ký; bỏ trống thì ký đúng như payment. */
  const hook = (raw: string, signature: string | null = signWebhook(SECRET, raw, nowSeconds())) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/payment',
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { 'x-signature': signature }),
      },
      payload: raw,
    });
  const balanceOf = async (customer: string): Promise<number> =>
    Number(
      (
        await h.db
          .withSchema('t_acme')
          .selectFrom('accounts')
          .select('balance')
          .where('id', '=', `wallet:${customer}`)
          .executeTakeFirstOrThrow()
      ).balance,
    );
  const statusOf = async (topupId: string): Promise<string> =>
    (
      await h.db
        .withSchema('t_acme')
        .selectFrom('topups')
        .select('status')
        .where('id', '=', topupId)
        .executeTakeFirstOrThrow()
    ).status;

  it('credits the wallet for a correctly signed charge.succeeded, with no tenant headers', async () => {
    const seeded = await seedTopup(h);
    const res = await hook(body(seeded));
    expect(res.statusCode).toBe(200);
    expect(await statusOf(seeded.topupId)).toBe('SUCCEEDED');
    expect(await balanceOf(seeded.customer)).toBe(150000);
  });

  it('answers 200 and applies nothing for a repeated delivery', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    expect((await hook(raw)).statusCode).toBe(200);
    expect((await hook(raw)).statusCode).toBe(200);
    expect(await balanceOf(seeded.customer)).toBe(150000);
  });

  it('fails the topup for charge.failed', async () => {
    const seeded = await seedTopup(h);
    const res = await hook(
      body(seeded, { type: 'charge.failed' }, { status: 'FAILED', failureCode: 'card_declined' }),
    );
    expect(res.statusCode).toBe(200);
    expect(await statusOf(seeded.topupId)).toBe('FAILED');
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('answers 200 for inconsistent events (unknown topup, amount mismatch) so payment stops retrying', async () => {
    const seeded = await seedTopup(h);
    expect((await hook(body({ ...seeded, topupId: 'tp_missing' }))).statusCode).toBe(200);
    expect((await hook(body({ ...seeded, amount: seeded.amount + 1 }))).statusCode).toBe(200);
    expect(await statusOf(seeded.topupId)).toBe('PENDING');
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('rejects a missing, malformed or wrong signature with 401 INVALID_SIGNATURE and applies nothing', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const wrongSecret = signWebhook('another-secret', raw, nowSeconds());
    for (const signature of [null, 'garbage', wrongSecret]) {
      const res = await hook(raw, signature);
      expect(res.statusCode, String(signature)).toBe(401);
      expect(errorOf(res.body).code).toBe('INVALID_SIGNATURE');
    }
    expect(await statusOf(seeded.topupId)).toBe('PENDING');
  });

  it('rejects a body that was modified after signing, even by a single character', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const signature = signWebhook(SECRET, raw, nowSeconds());
    const res = await hook(raw.replace('"amount": 150000', '"amount": 150001'), signature);
    expect(res.statusCode).toBe(401);
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('rejects a replay whose timestamp is outside the tolerance', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const stale = signWebhook(SECRET, raw, nowSeconds() - 301);
    const res = await hook(raw, stale);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe('INVALID_SIGNATURE');
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('checks the signature before the body: malformed JSON is 401 when unsigned or mis-signed, 400 INVALID_WEBHOOK when signed', async () => {
    const broken = '{"eventId": ';
    for (const signature of [
      null,
      'garbage',
      signWebhook('another-secret', broken, nowSeconds()),
    ]) {
      const res = await hook(broken, signature);
      expect(res.statusCode).toBe(401);
      expect(errorOf(res.body).code).toBe('INVALID_SIGNATURE');
    }
    const signed = await hook(broken);
    expect(signed.statusCode).toBe(400);
    expect(errorOf(signed.body).code).toBe('INVALID_WEBHOOK');
  });

  it('rejects a correctly signed payload that is invalid or points to an unknown tenant with 400 INVALID_WEBHOOK', async () => {
    const seeded = await seedTopup(h);
    const cases: Array<[string, string]> = [
      ['no metadata', body(seeded, {}, { metadata: undefined })],
      ['no tenantId', body(seeded, {}, { metadata: { other: 'x' } })],
      ['an unknown tenant', body(seeded, {}, { metadata: { tenantId: 'ghost' } })],
      ['a malformed tenant', body(seeded, {}, { metadata: { tenantId: "acme'--" } })],
      [
        'a failed event without failureCode',
        body(seeded, { type: 'charge.failed' }, { status: 'FAILED' }),
      ],
      ['a payload that is not a charge event', JSON.stringify({ hello: 'world' })],
    ];
    for (const [name, raw] of cases) {
      const res = await hook(raw);
      expect(res.statusCode, name).toBe(400);
      expect(errorOf(res.body).code, name).toBe('INVALID_WEBHOOK');
    }
    expect(await statusOf(seeded.topupId)).toBe('PENDING');
  });

  it('never puts the secret or a signature in a response or a log line', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const signature = signWebhook(SECRET, raw, nowSeconds());
    const responses = [
      await hook(raw, signature),
      await hook(raw, 'garbage'),
      await hook(raw, signWebhook('x', raw, nowSeconds())),
    ];
    const everything = JSON.stringify({
      bodies: responses.map((r) => r.body),
      headers: responses.map((r) => r.headers),
      logs,
    });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(signature);
    expect(everything).not.toContain('v1=');
  });
});
