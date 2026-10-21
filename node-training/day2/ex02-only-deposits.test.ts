import { expect, test } from 'vitest';
import { onlyDeposits } from './ex02-only-deposits.js';

const list = [
  { id: 'a', type: 'deposit', amount: 100 },
  { id: 'b', type: 'withdraw', amount: 30 },
  { id: 'c', type: 'deposit', amount: 50 },
] as const;

test('giữ lại giao dịch nạp tiền', () => {
  expect(onlyDeposits([...list]).map((t) => t.id)).toEqual(['a', 'c']);
});

test('không có giao dịch nạp', () => {
  expect(onlyDeposits([{ id: 'x', type: 'withdraw', amount: 1 }])).toEqual([]);
});
