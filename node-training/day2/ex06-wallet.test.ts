import { expect, test } from 'vitest';
import { Wallet } from './ex06-wallet.js';

test('ví mới', () => {
  const wallet = new Wallet('An');
  expect(wallet.owner).toBe('An');
  expect(wallet.balance).toBe(0);
});

test('nạp và rút', () => {
  const wallet = new Wallet('An');
  expect(wallet.deposit(100)).toBe(100);
  expect(wallet.withdraw(30)).toBe(70);
  expect(wallet.balance).toBe(70);
});

test('số tiền không hợp lệ', () => {
  const wallet = new Wallet('An');
  expect(() => wallet.deposit(0)).toThrow('amount must be a positive integer');
  expect(() => wallet.withdraw(2.5)).toThrow('amount must be a positive integer');
});

test('rút quá số dư thì lỗi và số dư không đổi', () => {
  const wallet = new Wallet('An');
  wallet.deposit(50);
  expect(() => wallet.withdraw(51)).toThrow('insufficient funds');
  expect(wallet.balance).toBe(50);
});
