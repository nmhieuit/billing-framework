import { expect, test } from 'vitest';
import { summarize } from './ex05-summary.js';

test('tóm tắt các giao dịch nạp', () => {
  expect(
    summarize([
      { id: 'a', type: 'deposit', amount: 100 },
      { id: 'b', type: 'withdraw', amount: 30 },
      { id: 'c', type: 'deposit', amount: 50 },
    ]),
  ).toEqual({ count: 2, totalDeposited: 150, ids: ['a', 'c'] });
});

test('không có giao dịch nạp', () => {
  expect(summarize([])).toEqual({ count: 0, totalDeposited: 0, ids: [] });
});
