import { expect, test } from 'vitest';
import { onlyDeposits } from './ex02-only-deposits.js';

// Danh sách mẫu gồm 2 giao dịch nạp (a, c) và 1 giao dịch rút (b)
const list = [
  { id: 'a', type: 'deposit', amount: 100 },
  { id: 'b', type: 'withdraw', amount: 30 },
  { id: 'c', type: 'deposit', amount: 50 },
] as const;

test('giữ lại giao dịch nạp tiền', () => {
  // [...list] sao chép thành mảng thường; map lấy ra id của từng giao dịch
  expect(onlyDeposits([...list]).map((t) => t.id)).toEqual(['a', 'c']);
});

test('không có giao dịch nạp', () => {
  expect(onlyDeposits([{ id: 'x', type: 'withdraw', amount: 1 }])).toEqual([]);
});
