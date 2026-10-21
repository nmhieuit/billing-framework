import { expect, test } from 'vitest';
import { formatTransaction } from './ex04-format-transaction.js';

test('nạp tiền có dấu +', () => {
  expect(formatTransaction({ id: 'a1', type: 'deposit', amount: 100 })).toBe('a1: +100');
});

test('rút tiền có dấu -', () => {
  expect(formatTransaction({ id: 'b2', type: 'withdraw', amount: 30 })).toBe('b2: -30');
});
