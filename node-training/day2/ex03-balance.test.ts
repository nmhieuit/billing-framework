import { expect, test } from 'vitest';
import { balanceOf } from './ex03-balance.js';

test('nạp cộng, rút trừ', () => {
  expect(
    balanceOf([
      { id: '1', type: 'deposit', amount: 100 },
      { id: '2', type: 'withdraw', amount: 30 },
      { id: '3', type: 'deposit', amount: 5 },
    ]),
  ).toBe(75);
});

test('rỗng', () => {
  expect(balanceOf([])).toBe(0);
});

test('có thể âm', () => {
  expect(balanceOf([{ id: '1', type: 'withdraw', amount: 10 }])).toBe(-10);
});
