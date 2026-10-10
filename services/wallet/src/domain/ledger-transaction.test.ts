import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { InvalidLedgerTransactionError } from './errors.js';
import { LedgerTransaction } from './ledger-transaction.js';

const now = new Date('2026-10-10T10:00:00.000Z');
const entry = (accountId: string, amount: number, currency: 'VND' | 'USD' = 'VND') => ({
  accountId,
  amount: Money.of(amount, currency),
});
const make = (entries = [entry('a', 100), entry('b', -100)], businessKey = 'k1') =>
  LedgerTransaction.create({ id: 'tx_1', businessKey, kind: 'TOPUP', entries, now });

describe('LedgerTransaction.create', () => {
  it('accepts a balanced transaction', () => {
    expect(make().toProps()).toMatchObject({
      id: 'tx_1',
      businessKey: 'k1',
      kind: 'TOPUP',
      createdAt: now,
    });
    expect(make().toProps().entries).toHaveLength(2);
  });

  it('accepts three balanced entries', () => {
    expect(() => make([entry('a', 70), entry('b', 30), entry('c', -100)])).not.toThrow();
  });

  it.each([
    ['unbalanced entries', [entry('a', 100), entry('b', -99)]],
    ['a single entry', [entry('a', 0)]],
    ['no entries', []],
    ['a zero entry', [entry('a', 100), entry('b', 0), entry('c', -100)]],
    ['duplicate accounts', [entry('a', 100), entry('a', -100)]],
    ['mixed currencies', [entry('a', 100), entry('b', -100, 'USD')]],
  ])('rejects %s', (_name, entries) => {
    expect(() => make(entries)).toThrow(InvalidLedgerTransactionError);
  });

  it.each(['', 'k'.repeat(201)])('rejects business key %j', (businessKey) => {
    expect(() => make(undefined, businessKey)).toThrow(InvalidLedgerTransactionError);
  });

  it('accepts a business key of exactly 200 characters', () => {
    expect(() => make(undefined, 'k'.repeat(200))).not.toThrow();
  });

  it('does not let callers mutate the stored entries', () => {
    const entries = [entry('a', 100), entry('b', -100)];
    const tx = make(entries);
    entries.push(entry('c', 5));
    expect(tx.toProps().entries).toHaveLength(2);
  });
});

describe('LedgerTransaction.topup', () => {
  const topup = (amount: number) =>
    LedgerTransaction.topup({
      id: 'tx_1',
      topupId: 'tp_1',
      walletAccountId: 'wallet:c1',
      gatewayAccountId: 'system:GATEWAY:VND',
      amount: Money.of(amount, 'VND'),
      now,
    });

  it('credits the wallet and debits the gateway under the topup business key', () => {
    const props = topup(1500).toProps();
    expect(props.businessKey).toBe('topup:tp_1');
    expect(props.kind).toBe('TOPUP');
    expect(props.entries.map((e) => [e.accountId, e.amount.amount])).toEqual([
      ['wallet:c1', 1500],
      ['system:GATEWAY:VND', -1500],
    ]);
  });

  it.each([0, -5])('rejects a non-positive amount (%d)', (amount) => {
    expect(() => topup(amount)).toThrow(InvalidLedgerTransactionError);
  });
});

describe('LedgerTransaction.orderPayment', () => {
  const make = (amount = 50000, orderId = '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11') =>
    LedgerTransaction.orderPayment({
      id: 'tx_1',
      orderId,
      walletAccountId: 'wallet:c1',
      merchantAccountId: 'system:MERCHANT:VND',
      amount: Money.of(amount, 'VND'),
      now,
    });

  it('debits the wallet, credits the merchant, and is keyed by the order', () => {
    const p = make().toProps();
    expect(p.kind).toBe('ORDER_PAYMENT');
    expect(p.businessKey).toBe('order:0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11');
    expect(p.entries.map((e) => [e.accountId, e.amount.amount])).toEqual([
      ['wallet:c1', -50000],
      ['system:MERCHANT:VND', 50000],
    ]);
  });

  it.each([0, -1])('rejects a non-positive amount (%d)', (amount) => {
    expect(() => make(amount)).toThrow(InvalidLedgerTransactionError);
  });

  it('rejects an order id that makes the business key too long', () => {
    expect(() => make(1, 'x'.repeat(200))).toThrow(InvalidLedgerTransactionError);
  });
});
