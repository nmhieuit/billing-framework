import { Money } from '@billing/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { InvalidQueryError, WalletNotFoundError } from './errors.js';
import { ListEntries } from './list-entries.js';

let h: Harness;
let createWallet: CreateWallet;
let listEntries: ListEntries;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  listEntries = new ListEntries({ uow: h.uow });
  await createWallet.execute({
    tenant: h.acme,
    customerId: CustomerId.parse('e1'),
    currency: 'VND',
  });
  for (const [index, amount] of [100, 200, 300].entries()) {
    await h.uow.run(h.acme, ({ ledger }) =>
      ledger.post(
        LedgerTransaction.topup({
          id: `tx_e${index}`,
          topupId: `tp_e${index}`,
          walletAccountId: 'wallet:e1',
          gatewayAccountId: 'system:GATEWAY:VND',
          amount: Money.of(amount, 'VND'),
          now: h.clock.now(),
        }),
      ),
    );
  }
});
afterAll(async () => {
  await h.close();
});

const customerId = CustomerId.parse('e1');
const query = (extra: { limit?: number; cursor?: string } = {}) => ({
  tenant: h.acme,
  customerId,
  ...extra,
});

describe('ListEntries', () => {
  it('lists the wallet entries in order with the business key of each transaction', async () => {
    const page = await listEntries.execute(query());
    expect(page.items.map((i) => [i.businessKey, i.amount])).toEqual([
      ['topup:tp_e0', 100],
      ['topup:tp_e1', 200],
      ['topup:tp_e2', 300],
    ]);
    expect(page.items[0]).toMatchObject({
      transactionId: 'tx_e0',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('walks the whole list one entry at a time without skipping or repeating', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 10; step++) {
      const page = await listEntries.execute(
        query({ limit: 1, ...(cursor === undefined ? {} : { cursor }) }),
      );
      seen.push(...page.items.map((i) => i.businessKey));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['topup:tp_e0', 'topup:tp_e1', 'topup:tp_e2']);
  });

  it('has no next page when the limit exactly matches the number of entries', async () => {
    const page = await listEntries.execute(query({ limit: 3 }));
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it.each([0, 1001, 1.5, Number.NaN, -1])('rejects the invalid limit %d', async (limit) => {
    await expect(listEntries.execute(query({ limit }))).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it.each(['abc', '-1', '1.5', '', '1234567890123456789', ' 1'])(
    'rejects the invalid cursor %j',
    async (cursor) => {
      await expect(listEntries.execute(query({ cursor }))).rejects.toBeInstanceOf(
        InvalidQueryError,
      );
    },
  );

  it('answers WalletNotFoundError when the customer has no wallet, and does not leak across tenants', async () => {
    await expect(
      listEntries.execute({ tenant: h.acme, customerId: CustomerId.parse('nobody') }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(
      listEntries.execute({ tenant: h.beta, customerId: CustomerId.parse('e1') }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
