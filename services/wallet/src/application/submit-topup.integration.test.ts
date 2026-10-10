import type { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import type { GatewayChargeRequest, GatewayChargeResult, PaymentGateway } from './ports.js';
import { RequestTopup } from './request-topup.js';
import { SubmitTopup } from './submit-topup.js';

class ScriptedGateway implements PaymentGateway {
  readonly requests: GatewayChargeRequest[] = [];
  #script: GatewayChargeResult[] = [];
  onCall: ((request: GatewayChargeRequest) => Promise<void>) | undefined;

  enqueue(...results: GatewayChargeResult[]): this {
    this.#script.push(...results);
    return this;
  }

  async createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult> {
    this.requests.push(request);
    await this.onCall?.(request);
    return this.#script.shift() ?? { kind: 'created', chargeId: `ch_${this.requests.length}` };
  }
}

let h: Harness;
let gateway: ScriptedGateway;
let submit: SubmitTopup;
let requestTopup: RequestTopup;
let createWallet: CreateWallet;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  requestTopup = new RequestTopup({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    submitter: { submitSoon: () => undefined },
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  for (const schema of ['t_acme', 't_beta']) {
    await h.db
      .withSchema(schema)
      .updateTable('topups')
      .set({ status: 'FAILED', failure_code: 'TEST_CLEANUP', next_attempt_at: null })
      .where('status', '=', 'REQUESTED')
      .execute();
  }
  gateway = new ScriptedGateway();
  submit = new SubmitTopup({
    uow: h.uow,
    gateway,
    clock: h.clock,
    backoffSeconds: [1, 5],
    leaseSeconds: 60,
  });
  h.clock.set('2026-10-10T10:00:00.000Z');
});

/** Tạo ví mới rồi một lần nạp REQUESTED cho khách đó; mỗi test dùng khách riêng nên không ảnh hưởng nhau. */
async function seed(
  tenant: TenantId = h.acme,
  amount = 150000,
): Promise<{ tenant: TenantId; topupId: string; customer: string }> {
  const customer = `s${++counter}`;
  await createWallet.execute({ tenant, customerId: CustomerId.parse(customer), currency: 'VND' });
  const { body } = await requestTopup.execute({
    tenant,
    customerId: CustomerId.parse(customer),
    idempotencyKey: 'k',
    amount,
  });
  return { tenant, topupId: body.topupId, customer };
}
const row = async (tenant: TenantId, id: string) =>
  (
    await h.db
      .withSchema(`t_${tenant.value}`)
      .selectFrom('topups')
      .selectAll()
      .where('id', '=', id)
      .execute()
  )[0];
const plusSeconds = (seconds: number) =>
  new Date(new Date('2026-10-10T10:00:00.000Z').getTime() + seconds * 1000);

describe('SubmitTopup', () => {
  it('sends the charge with the documented idempotency key, reference and tenant metadata, then marks it PENDING', async () => {
    const { tenant, topupId } = await seed();
    expect(await submit.executeFor(tenant, topupId)).toBe('SUBMITTED');
    expect(gateway.requests).toHaveLength(1);
    const sent = gateway.requests[0];
    expect(sent).toMatchObject({
      idempotencyKey: `topup:acme:${topupId}`,
      reference: topupId,
      metadata: { tenantId: 'acme' },
    });
    expect((sent?.amount as Money).amount).toBe(150000);
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'PENDING',
      charge_id: 'ch_1',
      attempts: 1,
      next_attempt_at: null,
    });
  });

  it('fails immediately when the gateway rejects the request', async () => {
    const { tenant, topupId } = await seed();
    gateway.enqueue({ kind: 'rejected', status: 422, message: 'bad' });
    expect(await submit.executeFor(tenant, topupId)).toBe('REJECTED');
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PAYMENT_REJECTED',
      attempts: 1,
      next_attempt_at: null,
    });
  });

  it('retries on the backoff schedule and gives up with PAYMENT_UNAVAILABLE when attempts run out', async () => {
    const { tenant, topupId } = await seed();
    gateway.enqueue(
      ...Array.from({ length: 3 }, () => ({ kind: 'unavailable', error: 'down' }) as const),
    );

    expect(await submit.executeFor(tenant, topupId)).toBe('RETRY_SCHEDULED');
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'REQUESTED',
      attempts: 1,
      next_attempt_at: plusSeconds(1),
    });

    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    expect(gateway.requests).toHaveLength(1);

    h.clock.advanceSeconds(1);
    expect(await submit.executeFor(tenant, topupId)).toBe('RETRY_SCHEDULED');
    expect(await row(tenant, topupId)).toMatchObject({
      attempts: 2,
      next_attempt_at: plusSeconds(6),
    });

    h.clock.advanceSeconds(5);
    expect(await submit.executeFor(tenant, topupId)).toBe('FAILED');
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PAYMENT_UNAVAILABLE',
      attempts: 3,
      next_attempt_at: null,
    });
    h.clock.advanceSeconds(10_000);
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    expect(gateway.requests).toHaveLength(3);
  });

  it('uses the same idempotency key on every retry and ends up PENDING once the gateway recovers', async () => {
    const { tenant, topupId } = await seed();
    gateway.enqueue({ kind: 'unavailable', error: 'down' }, { kind: 'created', chargeId: 'ch_ok' });
    await submit.executeFor(tenant, topupId);
    h.clock.advanceSeconds(1);
    expect(await submit.executeFor(tenant, topupId)).toBe('SUBMITTED');
    expect(new Set(gateway.requests.map((r) => r.idempotencyKey)).size).toBe(1);
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'PENDING',
      charge_id: 'ch_ok',
      attempts: 2,
    });
  });

  it('does not resend a topup that is leased until the lease expires (crash recovery)', async () => {
    const { tenant, topupId } = await seed();
    await h.uow.run(tenant, async ({ topups }) => {
      const topup = await topups.lockById(topupId);
      if (!topup) throw new Error('missing topup');
      await topups.save(topup.claim(h.clock.now(), 60));
    });
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    h.clock.advanceSeconds(59);
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    h.clock.advanceSeconds(1);
    expect(await submit.executeFor(tenant, topupId)).toBe('SUBMITTED');
  });

  it('leaves a topup alone when the webhook settled it while the charge request was in flight (SUPERSEDED)', async () => {
    const { tenant, topupId } = await seed();
    gateway.onCall = async () => {
      await h.uow.run(tenant, async ({ topups }) => {
        const topup = await topups.lockById(topupId);
        if (!topup) throw new Error('missing topup');
        await topups.save(topup.applySucceeded('ch_from_webhook', h.clock.now()));
      });
    };
    expect(await submit.executeFor(tenant, topupId)).toBe('SUPERSEDED');
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'SUCCEEDED',
      charge_id: 'ch_from_webhook',
    });
  });

  it('answers NOT_DUE for an unknown topup and for one that is no longer REQUESTED', async () => {
    const { tenant, topupId } = await seed();
    expect(await submit.executeFor(tenant, 'tp_nope')).toBe('NOT_DUE');
    await submit.executeFor(tenant, topupId);
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
  });

  it('executeNextDue() takes the oldest due topup, returns null when nothing is due, and ignores other tenants', async () => {
    const older = await seed(h.acme);
    h.clock.advanceSeconds(5);
    await seed(h.acme);
    expect(await submit.executeNextDue(h.acme)).toBe('SUBMITTED');
    expect(gateway.requests[0]?.reference).toBe(older.topupId);

    const betaOnly = await seed(h.beta);
    expect(await submit.executeNextDue(h.acme)).toBe('SUBMITTED');
    expect(await submit.executeNextDue(h.acme)).toBeNull();
    expect((await row(betaOnly.tenant, betaOnly.topupId))?.status).toBe('REQUESTED');
  });

  it('never submits the same topup twice when two workers run at once', async () => {
    await seed();
    await seed();
    const outcomes = await Promise.all([
      submit.executeNextDue(h.acme),
      submit.executeNextDue(h.acme),
    ]);
    expect(outcomes).toEqual(['SUBMITTED', 'SUBMITTED']);
    expect(new Set(gateway.requests.map((r) => r.reference)).size).toBe(2);
  });
});
