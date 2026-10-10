import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import type { GatewayChargeRequest, GatewayChargeResult, PaymentGateway } from './ports.js';
import { RequestTopup } from './request-topup.js';
import { SubmitDueTopups } from './submit-due-topups.js';
import { SubmitTopup } from './submit-topup.js';

let h: Harness;
let requestTopup: RequestTopup;
let createWallet: CreateWallet;
let counter = 0;
const sent: string[] = [];
let outcome: (request: GatewayChargeRequest) => GatewayChargeResult = (request) => ({
  kind: 'created',
  chargeId: `ch_${request.reference}`,
});
const gateway: PaymentGateway = {
  async createCharge(request) {
    sent.push(request.reference);
    return outcome(request);
  },
};

let submitDue: SubmitDueTopups;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  requestTopup = new RequestTopup({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    submitter: { submitSoon: () => undefined },
  });
  submitDue = new SubmitDueTopups({
    submit: new SubmitTopup({
      uow: h.uow,
      gateway,
      clock: h.clock,
      backoffSeconds: [1],
      leaseSeconds: 60,
    }),
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  sent.length = 0;
  outcome = (request) => ({ kind: 'created', chargeId: `ch_${request.reference}` });
  h.clock.set('2026-10-10T10:00:00.000Z');
  for (const schema of ['t_acme', 't_beta']) {
    await h.db
      .withSchema(schema)
      .updateTable('topups')
      .set({ status: 'FAILED', failure_code: 'TEST_CLEANUP', next_attempt_at: null })
      .where('status', '=', 'REQUESTED')
      .execute();
  }
});

async function seed(tenant: TenantId): Promise<string> {
  const customer = `d${++counter}`;
  await createWallet.execute({ tenant, customerId: CustomerId.parse(customer), currency: 'VND' });
  const { body } = await requestTopup.execute({
    tenant,
    customerId: CustomerId.parse(customer),
    idempotencyKey: 'k',
    amount: 100,
  });
  h.clock.advanceSeconds(1);
  return body.topupId;
}
const status = async (tenant: TenantId, id: string) =>
  (
    await h.db
      .withSchema(`t_${tenant.value}`)
      .selectFrom('topups')
      .select(['status', 'next_attempt_at'])
      .where('id', '=', id)
      .execute()
  )[0];

describe('SubmitDueTopups', () => {
  it('submits every due topup of the tenant, oldest first, and reports the outcomes', async () => {
    const ids = [await seed(h.acme), await seed(h.acme), await seed(h.acme)];
    h.clock.advanceSeconds(10);
    expect(await submitDue.execute(h.acme)).toEqual({
      submitted: 3,
      rejected: 0,
      retrying: 0,
      failed: 0,
      superseded: 0,
    });
    expect(sent).toEqual(ids);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 3; i++) await seed(h.acme);
    h.clock.advanceSeconds(10);
    expect((await submitDue.execute(h.acme, 2)).submitted).toBe(2);
    expect((await submitDue.execute(h.acme, 2)).submitted).toBe(1);
  });

  it('counts rejected, retrying and failed outcomes separately', async () => {
    await seed(h.acme);
    await seed(h.acme);
    await seed(h.acme);
    h.clock.advanceSeconds(10);
    const script: GatewayChargeResult[] = [
      { kind: 'rejected', status: 422, message: 'bad' },
      { kind: 'unavailable', error: 'down' },
      { kind: 'created', chargeId: 'ch_x' },
    ];
    outcome = () => script.shift() ?? { kind: 'created', chargeId: 'ch_y' };
    expect(await submitDue.execute(h.acme)).toEqual({
      submitted: 1,
      rejected: 1,
      retrying: 1,
      failed: 0,
      superseded: 0,
    });
  });

  it('stops claiming new topups once shouldContinue turns false, leaving the rest untouched and unleased', async () => {
    const ids = [await seed(h.acme), await seed(h.acme), await seed(h.acme)];
    h.clock.advanceSeconds(10);
    let sends = 0;
    outcome = () => {
      sends += 1;
      return { kind: 'created', chargeId: 'ch_z' };
    };
    const report = await submitDue.execute(h.acme, 50, { shouldContinue: () => sends < 1 });
    expect(report).toEqual({ submitted: 1, rejected: 0, retrying: 0, failed: 0, superseded: 0 });
    expect((await status(h.acme, ids[0] ?? ''))?.status).toBe('PENDING');
    for (const id of ids.slice(1)) {
      const row = await status(h.acme, id);
      expect(row?.status).toBe('REQUESTED');
      expect(row?.next_attempt_at).not.toBeNull();
      expect((row?.next_attempt_at as Date).getTime()).toBeLessThanOrEqual(h.clock.now().getTime());
    }
  });

  it('only touches the given tenant', async () => {
    const inBeta = await seed(h.beta);
    await seed(h.acme);
    h.clock.advanceSeconds(10);
    await submitDue.execute(h.acme);
    expect((await status(h.beta, inBeta))?.status).toBe('REQUESTED');
  });

  it('does nothing when nothing is due', async () => {
    expect(await submitDue.execute(h.acme)).toEqual({
      submitted: 0,
      rejected: 0,
      retrying: 0,
      failed: 0,
      superseded: 0,
    });
    expect(sent).toHaveLength(0);
  });
});
