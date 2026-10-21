import { expect, test } from 'vitest';
import { totalsByType } from './ex06-totals.js';

test('gộp theo loại', () => {
  const result = totalsByType([
    { type: 'deposit', amount: 100 },
    { type: 'withdraw', amount: 30 },
    { type: 'deposit', amount: 50 },
  ]);
  expect(result).toEqual({ deposit: 150, withdraw: 30 });
});

test('danh sách rỗng', () => {
  expect(totalsByType([])).toEqual({});
});

test('chỉ có một loại', () => {
  expect(totalsByType([{ type: 'refund', amount: 5 }])).toEqual({ refund: 5 });
});
