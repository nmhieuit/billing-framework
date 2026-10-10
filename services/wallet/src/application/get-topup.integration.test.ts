import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { TopupNotFoundError } from './errors.js';
import { GetTopup } from './get-topup.js';
import { RequestTopup } from './request-topup.js';

let h: Harness;
let requestTopup: RequestTopup;
let getTopup: GetTopup;

beforeAll(async () => {
  h = await createHarness();
  const createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  requestTopup = new RequestTopup({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    submitter: { submitSoon: () => undefined },
  });
  getTopup = new GetTopup({ uow: h.uow });
  for (const [tenant, customer] of [
    [h.acme, 'g1'],
    [h.acme, 'g2'],
    [h.beta, 'g1'],
  ] as const) {
    await createWallet.execute({ tenant, customerId: CustomerId.parse(customer), currency: 'VND' });
  }
});
afterAll(async () => {
  await h.close();
});

describe('GetTopup', () => {
  it('shows the topup of the caller without completion fields while it is REQUESTED', async () => {
    const { body } = await requestTopup.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      idempotencyKey: 'k',
      amount: 900,
    });
    expect(
      await getTopup.execute({
        tenant: h.acme,
        customerId: CustomerId.parse('g1'),
        topupId: body.topupId,
      }),
    ).toStrictEqual({
      topupId: body.topupId,
      status: 'REQUESTED',
      amount: 900,
      currency: 'VND',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
  });

  it("hides another customer's topup and an unknown id behind the same error", async () => {
    const { body } = await requestTopup.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      idempotencyKey: 'k2',
      amount: 5,
    });
    await expect(
      getTopup.execute({
        tenant: h.acme,
        customerId: CustomerId.parse('g2'),
        topupId: body.topupId,
      }),
    ).rejects.toBeInstanceOf(TopupNotFoundError);
    await expect(
      getTopup.execute({ tenant: h.acme, customerId: CustomerId.parse('g1'), topupId: 'tp_nope' }),
    ).rejects.toBeInstanceOf(TopupNotFoundError);
  });

  it('does not see a topup that belongs to another tenant, even for the same customer id', async () => {
    const { body } = await requestTopup.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      idempotencyKey: 'k3',
      amount: 5,
    });
    await expect(
      getTopup.execute({
        tenant: h.beta,
        customerId: CustomerId.parse('g1'),
        topupId: body.topupId,
      }),
    ).rejects.toBeInstanceOf(TopupNotFoundError);
  });
});
