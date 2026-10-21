import { expect, test } from 'vitest';
import { createWallet, deposit } from './ex05-wallet.js';

test('ví mới có số dư 0', () => {
  expect(createWallet('An')).toEqual({ owner: 'An', balance: 0 });
});

test('nạp tiền cộng dồn và trả về số dư mới', () => {
  const wallet = createWallet('An');
  expect(deposit(wallet, 100)).toBe(100);
  expect(deposit(wallet, 50)).toBe(150);
  expect(wallet.balance).toBe(150);
});

test('từ chối số tiền không hợp lệ', () => {
  const wallet = createWallet('An');
  expect(() => deposit(wallet, 0)).toThrow('amount must be a positive integer');
  expect(() => deposit(wallet, -5)).toThrow('amount must be a positive integer');
  expect(() => deposit(wallet, 1.5)).toThrow('amount must be a positive integer');
  expect(wallet.balance).toBe(0);
});
