import { InvalidMoneyError } from '@billing/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { WalletCurrencyConflictError } from './errors.js';

let h: Harness;
let createWallet: CreateWallet;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});

const walletRows = (schema: string) =>
  h.db.withSchema(schema).selectFrom('accounts').selectAll().where('kind', '=', 'WALLET').execute();

describe('CreateWallet', () => {
  it('creates an empty wallet and reports it as created', async () => {
    const result = await createWallet.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('w1'),
      currency: 'VND',
    });
    expect(result).toEqual({
      created: true,
      wallet: {
        customerId: 'w1',
        currency: 'VND',
        balance: 0,
        createdAt: '2026-10-10T10:00:00.000Z',
      },
    });
  });

  it('is idempotent for the same customer and currency', async () => {
    const input = { tenant: h.acme, customerId: CustomerId.parse('w2'), currency: 'USD' };
    const first = await createWallet.execute(input);
    h.clock.advanceSeconds(30);
    const again = await createWallet.execute(input);
    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, wallet: first.wallet });
  });

  it('refuses a second wallet in another currency for the same customer', async () => {
    await createWallet.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('w3'),
      currency: 'VND',
    });
    await expect(
      createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w3'), currency: 'USD' }),
    ).rejects.toBeInstanceOf(WalletCurrencyConflictError);
  });

  it('rejects an unsupported currency and persists nothing', async () => {
    await expect(
      createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w4'), currency: 'EUR' }),
    ).rejects.toBeInstanceOf(InvalidMoneyError);
    const rows = await walletRows('t_acme');
    expect(rows.find((r) => r.id === 'wallet:w4')).toBeUndefined();
  });

  it('creates exactly one wallet when the same customer is created concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createWallet.execute({
          tenant: h.acme,
          customerId: CustomerId.parse('w5'),
          currency: 'VND',
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await walletRows('t_acme')).filter((r) => r.id === 'wallet:w5')).toHaveLength(1);
  });

  it('gives the same customer id an independent wallet in each tenant', async () => {
    const inAcme = await createWallet.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('w6'),
      currency: 'VND',
    });
    const inBeta = await createWallet.execute({
      tenant: h.beta,
      customerId: CustomerId.parse('w6'),
      currency: 'USD',
    });
    expect(inAcme.created && inBeta.created).toBe(true);
    expect(inAcme.wallet.currency).toBe('VND');
    expect(inBeta.wallet.currency).toBe('USD');
  });
});
