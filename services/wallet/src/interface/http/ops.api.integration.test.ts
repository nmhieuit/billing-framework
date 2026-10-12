import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../app.module.js';
import { AdjustWallet } from '../../application/adjust-wallet.js';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { CreateWallet } from '../../application/create-wallet.js';
import { FreezeWallet } from '../../application/freeze-wallet.js';
import { GetTopup } from '../../application/get-topup.js';
import { GetWallet } from '../../application/get-wallet.js';
import { ListEntries } from '../../application/list-entries.js';
import { ListOpsActions } from '../../application/list-ops-actions.js';
import { OpsActionRecorder } from '../../application/ops-recorder.js';
import { PayOrder } from '../../application/pay-order.js';
import { ReplayOrderPaid } from '../../application/replay-order-paid.js';
import { RequestTopup } from '../../application/request-topup.js';
import { ReverseTransaction } from '../../application/reverse-transaction.js';
import { RecordingMetrics } from '../../test-support-metrics.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  silentLogger,
  type Harness,
} from '../../test-support.js';
import { createApp } from './create-app.js';

let h: Harness;
let app: NestFastifyApplication;
let pay: PayOrder;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  const recorder = new OpsActionRecorder({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    metrics: new RecordingMetrics(),
  });
  const reject = { execute: () => Promise.reject(new Error('not used')) };
  const deps: AppDeps = {
    registry: h.registry,
    clock: h.clock,
    log: silentLogger,
    webhookSecret: 'whsec_test_secret_value',
    createWallet: new CreateWallet({ uow: h.uow, clock: h.clock }),
    getWallet: new GetWallet({ uow: h.uow }),
    listEntries: new ListEntries({ uow: h.uow }),
    requestTopup: new RequestTopup({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      submitter: { submitSoon: () => undefined },
    }),
    getTopup: new GetTopup({ uow: h.uow }),
    applyPaymentResult: new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
    }),
    startReconciliation: reject,
    getReconciliationRun: reject,
    listReconciliationItems: reject,
    resolveReconciliationItem: reject,
    freezeWallet: new FreezeWallet({ recorder }),
    adjustWallet: new AdjustWallet({ recorder, ids: h.ids }),
    reverseTransaction: new ReverseTransaction({ recorder, ids: h.ids }),
    replayOrderPaid: new ReplayOrderPaid({ recorder, ids: h.ids }),
    listOpsActions: new ListOpsActions({ uow: h.uow }),
  };
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
  app = await createApp(deps);
});
afterEach(async () => {
  await app.close();
  await expectLedgerInvariants(h, h.acme);
});

const ops = { 'x-tenant-id': 'acme', 'x-actor-id': 'op@x', 'x-actor-role': 'OPS' };
const newCustomer = () => `ox${++counter}-${randomUUID().slice(0, 8)}`;
const key = () => `ops-key-${++counter}-${randomUUID()}`;
const errorOf = (body: string): { code: string; message: string } =>
  (JSON.parse(body) as { error: { code: string; message: string } }).error;
const call = (
  method: 'POST' | 'GET',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = ops,
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const body = (extra: Record<string, unknown> = {}) => ({
  reason: 'support ticket 42',
  idempotencyKey: key(),
  ...extra,
});
const adjustBody = (extra: Record<string, unknown> = {}) =>
  body({ direction: 'CREDIT', amount: 20000, currency: 'VND', ...extra });
const schema = 't_acme';
const balance = async (id: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(schema)
        .selectFrom('accounts')
        .select('balance')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).balance,
  );
const auditRows = async (idempotencyKey: string) =>
  h.db
    .withSchema(schema)
    .selectFrom('ops_actions')
    .selectAll()
    .where('idempotency_key', '=', idempotencyKey)
    .execute();
const fundedCustomer = async (amount = 100000) => {
  const customer = newCustomer();
  await fundWallet(h, { customer, amount });
  return customer;
};
const payOrder = async (customer: string, amount = 50000) => {
  const orderId = randomUUID();
  const outcome = await pay.execute({
    tenant: h.acme,
    eventId: randomUUID(),
    correlationId: 'corr-1',
    orderId,
    customerId: customer,
    amount,
    currency: 'VND',
  });
  if (outcome.kind !== 'PAID') throw new Error('order not paid');
  return { orderId, transactionId: outcome.walletTransactionId };
};

describe('ops authentication', () => {
  it('answers 401 MISSING_ACTOR without x-actor-id, even with customer headers', async () => {
    const res = await call('GET', '/ops/actions', undefined, {
      'x-tenant-id': 'acme',
      'x-customer-id': 'c1',
      'x-actor-role': 'OPS',
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe('MISSING_ACTOR');
  });

  it('answers 403 FORBIDDEN_ROLE for a missing or non-OPS role', async () => {
    for (const role of [undefined, 'ADMIN']) {
      const headers: Record<string, string> = { 'x-tenant-id': 'acme', 'x-actor-id': 'op@x' };
      if (role) headers['x-actor-role'] = role;
      const res = await call('GET', '/ops/actions', undefined, headers);
      expect(res.statusCode).toBe(403);
      expect(errorOf(res.body).code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('answers 403 UNKNOWN_TENANT and 400 MISSING_TENANT', async () => {
    const unknown = await call('GET', '/ops/actions', undefined, { ...ops, 'x-tenant-id': 'zzz' });
    expect(unknown.statusCode).toBe(403);
    expect(errorOf(unknown.body).code).toBe('UNKNOWN_TENANT');
    const noTenant = { 'x-actor-id': 'op@x', 'x-actor-role': 'OPS' };
    const missing = await call('GET', '/ops/actions', undefined, noTenant);
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing.body).code).toBe('MISSING_TENANT');
  });
});

describe('freeze / unfreeze', () => {
  it('freezes then unfreezes a wallet (200) and replays the same body for the same key', async () => {
    const customer = await fundedCustomer();
    const first = body();
    const res = await call('POST', `/ops/wallets/${customer}/freeze`, first);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ customerId: customer, frozen: true, changed: true });
    const again = await call('POST', `/ops/wallets/${customer}/freeze`, first);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(res.json());
    expect(await auditRows(first.idempotencyKey)).toHaveLength(1);

    const undo = await call('POST', `/ops/wallets/${customer}/unfreeze`, body());
    expect(undo.statusCode).toBe(200);
    expect(undo.json()).toMatchObject({ frozen: false, changed: true });
  });

  it('answers 409 IDEMPOTENCY_CONFLICT when the key is reused for another request', async () => {
    const customer = await fundedCustomer();
    const first = body();
    await call('POST', `/ops/wallets/${customer}/freeze`, first);
    const clash = await call('POST', `/ops/wallets/${customer}/unfreeze`, first);
    expect(clash.statusCode).toBe(409);
    expect(errorOf(clash.body).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    const res = await call('POST', `/ops/wallets/${newCustomer()}/freeze`, body());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe('WALLET_NOT_FOUND');
  });

  it('answers 422 INVALID_OPS_REQUEST for blank or non-string fields, 400 for a non-object body', async () => {
    const customer = await fundedCustomer();
    const blank = await call('POST', `/ops/wallets/${customer}/freeze`, body({ reason: '  ' }));
    expect(blank.statusCode).toBe(422);
    expect(errorOf(blank.body).code).toBe('INVALID_OPS_REQUEST');
    const wrongType = await call('POST', `/ops/wallets/${customer}/freeze`, body({ reason: 42 }));
    expect(wrongType.statusCode).toBe(422);
    const array = await app.inject({
      method: 'POST',
      url: `/ops/wallets/${customer}/freeze`,
      headers: ops,
      payload: [],
    });
    expect(array.statusCode).toBe(400);
  });
});

describe('adjustments', () => {
  it('credits a wallet (201), replays the same body, and records the header actor, not the body actor', async () => {
    const customer = await fundedCustomer();
    const before = await balance(`wallet:${customer}`);
    const request = adjustBody({ actor: 'mallory@evil' });
    const res = await call('POST', `/ops/wallets/${customer}/adjustments`, request);
    expect(res.statusCode).toBe(201);
    const { transactionId, actionId } = res.json<{ transactionId: string; actionId: string }>();
    expect(await balance(`wallet:${customer}`)).toBe(before + 20000);

    const again = await call('POST', `/ops/wallets/${customer}/adjustments`, request);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({ transactionId, actionId });
    expect(await balance(`wallet:${customer}`)).toBe(before + 20000);

    const rows = await auditRows(request.idempotencyKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe('op@x');
  });

  it('answers 409 IDEMPOTENCY_CONFLICT when the same key carries a different amount', async () => {
    const customer = await fundedCustomer();
    const request = adjustBody();
    await call('POST', `/ops/wallets/${customer}/adjustments`, request);
    const clash = await call('POST', `/ops/wallets/${customer}/adjustments`, {
      ...request,
      amount: 30000,
    });
    expect(clash.statusCode).toBe(409);
    expect(errorOf(clash.body).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('answers 409 INSUFFICIENT_FUNDS when a debit would overdraw the wallet', async () => {
    const customer = await fundedCustomer(10000);
    const res = await call(
      'POST',
      `/ops/wallets/${customer}/adjustments`,
      adjustBody({ direction: 'DEBIT', amount: 50000 }),
    );
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe('INSUFFICIENT_FUNDS');
  });

  it('answers 422 for a non-numeric amount, a bad direction or a currency mismatch', async () => {
    const customer = await fundedCustomer();
    for (const extra of [{ amount: '20000' }, { direction: 'SIDEWAYS' }, { currency: 'USD' }]) {
      const res = await call('POST', `/ops/wallets/${customer}/adjustments`, adjustBody(extra));
      expect(res.statusCode).toBe(422);
      expect(errorOf(res.body).code).toBe('INVALID_OPS_REQUEST');
    }
  });

  it('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    const res = await call('POST', `/ops/wallets/${newCustomer()}/adjustments`, adjustBody());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe('WALLET_NOT_FOUND');
  });
});

describe('reversals', () => {
  it('reverses an adjustment (201), replays the same body, and refuses a second reversal', async () => {
    const customer = await fundedCustomer();
    const adjusted = await call('POST', `/ops/wallets/${customer}/adjustments`, adjustBody());
    const { transactionId } = adjusted.json<{ transactionId: string }>();
    const before = await balance(`wallet:${customer}`);

    const request = body();
    const res = await call('POST', `/ops/transactions/${transactionId}/reversals`, request);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ reversesTransactionId: transactionId });
    expect(await balance(`wallet:${customer}`)).toBe(before - 20000);

    const again = await call('POST', `/ops/transactions/${transactionId}/reversals`, request);
    expect(again.json()).toEqual(res.json());

    const second = await call('POST', `/ops/transactions/${transactionId}/reversals`, body());
    expect(second.statusCode).toBe(409);
    expect(errorOf(second.body).code).toBe('ALREADY_REVERSED');
  });

  it('answers 404 TRANSACTION_NOT_FOUND for an unknown transaction', async () => {
    const res = await call('POST', `/ops/transactions/${randomUUID()}/reversals`, body());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe('TRANSACTION_NOT_FOUND');
  });

  it('answers 409 REVERSAL_NOT_SUPPORTED for a topup transaction', async () => {
    await fundedCustomer();
    const topupTx = await h.db
      .withSchema(schema)
      .selectFrom('ledger_transactions')
      .select('id')
      .where('kind', 'not in', ['ORDER_PAYMENT', 'ADJUSTMENT', 'REVERSAL'])
      .executeTakeFirstOrThrow();
    const res = await call('POST', `/ops/transactions/${topupTx.id}/reversals`, body());
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe('REVERSAL_NOT_SUPPORTED');
  });

  it('answers 409 INSUFFICIENT_FUNDS when the wallet has spent the credited funds', async () => {
    const customer = await fundedCustomer(10000);
    const adjusted = await call('POST', `/ops/wallets/${customer}/adjustments`, adjustBody());
    await call(
      'POST',
      `/ops/wallets/${customer}/adjustments`,
      adjustBody({ direction: 'DEBIT', amount: 25000 }),
    );
    const { transactionId } = adjusted.json<{ transactionId: string }>();
    const res = await call('POST', `/ops/transactions/${transactionId}/reversals`, body());
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe('INSUFFICIENT_FUNDS');
  });

  it('answers 409 REVERSAL_NOT_POSSIBLE when the merchant balance cannot absorb the reversal', async () => {
    const customer = await fundedCustomer();
    const { transactionId } = await payOrder(customer);
    const merchant = await balance('system:MERCHANT:VND');
    const setMerchant = (value: number) =>
      h.db
        .withSchema(schema)
        .updateTable('accounts')
        .set({ balance: value })
        .where('id', '=', 'system:MERCHANT:VND')
        .execute();
    await setMerchant(0);
    try {
      const res = await call('POST', `/ops/transactions/${transactionId}/reversals`, body());
      expect(res.statusCode).toBe(409);
      expect(errorOf(res.body).code).toBe('REVERSAL_NOT_POSSIBLE');
    } finally {
      await setMerchant(merchant);
    }
  });
});

describe('replay-paid', () => {
  it('replays OrderPaidV1 (202) and answers the same body for the same key', async () => {
    const customer = await fundedCustomer();
    const { orderId } = await payOrder(customer);
    const request = body();
    const res = await call('POST', `/ops/orders/${orderId}/replay-paid`, request);
    expect(res.statusCode).toBe(202);
    expect(res.json<{ eventId: string }>().eventId).toBeTruthy();
    const again = await call('POST', `/ops/orders/${orderId}/replay-paid`, request);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(res.json());
    expect(await auditRows(request.idempotencyKey)).toHaveLength(1);
  });

  it('answers 404 ORDER_NOT_FOUND for an unknown order', async () => {
    const res = await call('POST', `/ops/orders/${randomUUID()}/replay-paid`, body());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe('ORDER_NOT_FOUND');
  });

  it('answers 409 ORDER_REVERSED once the payment was reversed', async () => {
    const customer = await fundedCustomer();
    const { orderId, transactionId } = await payOrder(customer);
    await call('POST', `/ops/transactions/${transactionId}/reversals`, body());
    const res = await call('POST', `/ops/orders/${orderId}/replay-paid`, body());
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe('ORDER_REVERSED');
  });

  it('answers 409 EVENT_ID_UNKNOWN when the original event id was not recorded', async () => {
    const customer = await fundedCustomer();
    const { orderId } = await payOrder(customer);
    await h.db
      .withSchema(schema)
      .updateTable('order_payments')
      .set({ paid_event_id: null })
      .where('order_id', '=', orderId)
      .execute();
    const res = await call('POST', `/ops/orders/${orderId}/replay-paid`, body());
    expect(res.statusCode).toBe(409);
    expect(errorOf(res.body).code).toBe('EVENT_ID_UNKNOWN');
  });
});

describe('GET /ops/actions', () => {
  it('pages newest first without leaking keys or fingerprints', async () => {
    const customer = await fundedCustomer();
    for (let i = 0; i < 3; i++) {
      await call('POST', `/ops/wallets/${customer}/adjustments`, adjustBody());
    }
    const first = await call('GET', '/ops/actions?limit=2');
    expect(first.statusCode).toBe(200);
    const page1 = first.json<{ items: Array<Record<string, unknown>>; nextCursor: string }>();
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    expect(Object.keys(page1.items[0] ?? {}).sort()).toEqual(
      ['action', 'actor', 'createdAt', 'id', 'reason', 'target'].sort(),
    );
    expect(first.body).not.toContain('idempotency');
    expect(first.body).not.toContain('fingerprint');

    const second = await call('GET', `/ops/actions?limit=2&cursor=${page1.nextCursor}`);
    const page2 = second.json<{ items: Array<{ id: string }> }>();
    const ids = [...(page1.items as Array<{ id: string }>), ...page2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects repeated or invalid query parameters with 400 INVALID_QUERY', async () => {
    const urls = [
      '/ops/actions?limit=1&limit=2',
      '/ops/actions?cursor=a&cursor=b',
      '/ops/actions?limit=0',
    ];
    for (const url of urls) {
      const res = await call('GET', url);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res.body).code).toBe('INVALID_QUERY');
    }
  });
});
