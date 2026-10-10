import { InvalidMoneyError } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { InvalidTopupError } from '../domain/errors.js';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { IdempotencyConflictError, WalletNotFoundError } from './errors.js';
import type { TopupSubmitter } from './ports.js';
import { RequestTopup } from './request-topup.js';

class RecordingSubmitter implements TopupSubmitter {
  readonly calls: Array<{ tenant: string; topupId: string }> = [];
  submitSoon(tenant: TenantId, topupId: string): void {
    this.calls.push({ tenant: tenant.value, topupId });
  }
}

let h: Harness;
let createWallet: CreateWallet;
let requestTopup: RequestTopup;
let submitter: RecordingSubmitter;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  submitter = new RecordingSubmitter();
  requestTopup = new RequestTopup({ uow: h.uow, clock: h.clock, ids: h.ids, submitter });
  h.clock.set('2026-10-10T10:00:00.000Z');
});

const cust = (id: string) => CustomerId.parse(id);
const openWallet = (tenant: TenantId, customer: string, currency = 'VND') =>
  createWallet.execute({ tenant, customerId: cust(customer), currency });
const request = (customer: string, key: string, amount: number, tenant = h.acme) =>
  requestTopup.execute({ tenant, customerId: cust(customer), idempotencyKey: key, amount });
const topupRows = (schema: string) =>
  h.db.withSchema(schema).selectFrom('topups').selectAll().execute();

describe('RequestTopup', () => {
  it('records a REQUESTED topup due immediately and triggers one submission after the commit', async () => {
    await openWallet(h.acme, 'r1');
    const result = await request('r1', 'key-1', 150000);
    expect(result).toMatchObject({
      status: 202,
      replayed: false,
      body: {
        status: 'REQUESTED',
        amount: 150000,
        currency: 'VND',
        createdAt: '2026-10-10T10:00:00.000Z',
      },
    });
    const rows = (await topupRows('t_acme')).filter((r) => r.customer_id === 'r1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.body.topupId,
      account_id: 'wallet:r1',
      status: 'REQUESTED',
      attempts: 0,
      next_attempt_at: new Date('2026-10-10T10:00:00.000Z'),
    });
    expect(submitter.calls).toEqual([{ tenant: 'acme', topupId: result.body.topupId }]);
  });

  it('replays the stored 202 for the same key and content, without a second topup or submission', async () => {
    await openWallet(h.acme, 'r2');
    const first = await request('r2', 'key-1', 500);
    h.clock.advanceSeconds(30);
    const replay = await request('r2', 'key-1', 500);
    expect(replay).toMatchObject({ status: 202, replayed: true });
    expect(replay.body).toEqual(first.body);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r2')).toHaveLength(1);
    expect(submitter.calls).toHaveLength(1);
  });

  it('answers a conflict when the same key carries a different amount', async () => {
    await openWallet(h.acme, 'r3');
    await request('r3', 'key-1', 500);
    await expect(request('r3', 'key-1', 501)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r3')).toHaveLength(1);
  });

  it('treats keys as case-sensitive and scoped per customer', async () => {
    await openWallet(h.acme, 'r4');
    await openWallet(h.acme, 'r5');
    await request('r4', 'Key', 10);
    await request('r4', 'key', 10);
    await request('r5', 'Key', 10);
    expect(
      (await topupRows('t_acme')).filter((r) => ['r4', 'r5'].includes(r.customer_id)),
    ).toHaveLength(3);
  });

  it('creates exactly one topup and one submission when the same key arrives concurrently', async () => {
    await openWallet(h.acme, 'r6');
    const results = await Promise.all(Array.from({ length: 5 }, () => request('r6', 'key-1', 700)));
    expect(new Set(results.map((r) => r.body.topupId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r6')).toHaveLength(1);
    expect(submitter.calls).toHaveLength(1);
  });

  it('answers WalletNotFoundError when the customer has no wallet', async () => {
    await expect(request('ghost', 'key-1', 10)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(submitter.calls).toHaveLength(0);
  });

  it('keeps tenants apart: the same customer and key in two tenants are independent', async () => {
    await openWallet(h.acme, 'r7', 'VND');
    await openWallet(h.beta, 'r7', 'USD');
    const inAcme = await request('r7', 'key-1', 10, h.acme);
    const inBeta = await request('r7', 'key-1', 10, h.beta);
    expect(inAcme.body.currency).toBe('VND');
    expect(inBeta.body.currency).toBe('USD');
    expect(inAcme.body.topupId).not.toBe(inBeta.body.topupId);
    expect(inAcme.replayed || inBeta.replayed).toBe(false);
  });

  it.each([
    ['a fractional amount', 10.5, InvalidMoneyError],
    ['zero', 0, InvalidTopupError],
    ['a negative amount', -5, InvalidTopupError],
  ])('rejects %s and persists nothing', async (_name, amount, errorType) => {
    await openWallet(h.acme, 'r8');
    await expect(request('r8', `key-${String(amount)}`, amount)).rejects.toBeInstanceOf(errorType);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r8')).toHaveLength(0);
    expect(submitter.calls).toHaveLength(0);
  });
});
