import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { WalletNotFoundError } from './errors.js';
import { GetWallet } from './get-wallet.js';

let h: Harness;
let createWallet: CreateWallet;
let getWallet: GetWallet;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  getWallet = new GetWallet({ uow: h.uow });
});
afterAll(async () => {
  await h.close();
});

describe('GetWallet', () => {
  it('returns the wallet of the caller', async () => {
    await createWallet.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      currency: 'VND',
    });
    expect(await getWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('g1') })).toEqual(
      {
        customerId: 'g1',
        currency: 'VND',
        balance: 0,
        createdAt: '2026-10-10T10:00:00.000Z',
      },
    );
  });

  it('answers WalletNotFoundError for a customer without a wallet', async () => {
    await expect(
      getWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('nobody') }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  it('does not see a wallet that belongs to another tenant', async () => {
    await createWallet.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g2'),
      currency: 'VND',
    });
    await expect(
      getWallet.execute({ tenant: h.beta, customerId: CustomerId.parse('g2') }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
