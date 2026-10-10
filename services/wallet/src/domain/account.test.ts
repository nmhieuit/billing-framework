import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Account, type AccountProps } from './account.js';
import { CustomerId } from './customer-id.js';
import { InsufficientFundsError, LedgerInvariantError } from './errors.js';

const now = new Date('2026-10-10T10:00:00.000Z');

describe('Account ids', () => {
  it('derives deterministic ids', () => {
    expect(Account.walletId(CustomerId.parse('c1'))).toBe('wallet:c1');
    expect(Account.systemId('GATEWAY', 'VND')).toBe('system:GATEWAY:VND');
    expect(Account.systemId('MERCHANT', 'USD')).toBe('system:MERCHANT:USD');
  });
});

describe('Account.openWallet', () => {
  it('opens an empty wallet in the given currency', () => {
    const wallet = Account.openWallet({ customerId: CustomerId.parse('c1'), currency: 'VND', now });
    expect(wallet.toProps()).toEqual({
      id: 'wallet:c1',
      kind: 'WALLET',
      customerId: 'c1',
      currency: 'VND',
      balance: Money.zero('VND'),
      createdAt: now,
    });
  });
});

const rehydrate = (kind: AccountProps['kind'], balance: number, currency: 'VND' | 'USD' = 'VND') =>
  Account.rehydrate({
    id: kind === 'WALLET' ? 'wallet:c1' : `system:${kind}:${currency}`,
    kind,
    customerId: kind === 'WALLET' ? 'c1' : null,
    currency,
    balance: Money.of(balance, currency),
    createdAt: now,
  });

describe('Account.apply', () => {
  it('credits and debits a wallet but never lets it go negative', () => {
    const wallet = rehydrate('WALLET', 100);
    expect(wallet.apply(Money.of(50, 'VND')).toProps().balance.amount).toBe(150);
    expect(wallet.apply(Money.of(-100, 'VND')).toProps().balance.amount).toBe(0);
    expect(() => wallet.apply(Money.of(-101, 'VND'))).toThrow(InsufficientFundsError);
  });

  it('keeps the gateway account at or below zero', () => {
    const gateway = rehydrate('GATEWAY', -100);
    expect(gateway.apply(Money.of(-50, 'VND')).toProps().balance.amount).toBe(-150);
    expect(gateway.apply(Money.of(100, 'VND')).toProps().balance.amount).toBe(0);
    expect(() => gateway.apply(Money.of(101, 'VND'))).toThrow(LedgerInvariantError);
  });

  it('keeps the merchant account at or above zero', () => {
    const merchant = rehydrate('MERCHANT', 10);
    expect(merchant.apply(Money.of(-10, 'VND')).toProps().balance.amount).toBe(0);
    expect(() => merchant.apply(Money.of(-11, 'VND'))).toThrow(LedgerInvariantError);
  });

  it('rejects a delta in another currency', () => {
    expect(() => rehydrate('WALLET', 100).apply(Money.of(1, 'USD'))).toThrow(LedgerInvariantError);
  });

  it('is immutable', () => {
    const wallet = rehydrate('WALLET', 100);
    wallet.apply(Money.of(50, 'VND'));
    expect(wallet.toProps().balance.amount).toBe(100);
  });
});
