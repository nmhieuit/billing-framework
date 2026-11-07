import { expect, test } from 'vitest';
import { type Charge, summarize } from './ex10-bug-hunt.js';

// Dữ liệu mẫu: 2 charge thành công (100 + 25), 2 thất bại, 1 đang chờ.
// Charge mới nhất (createdAt lớn nhất = 3) là 'b'
const charges = [
  { id: 'a', amount: 100, status: 'succeeded', createdAt: 1 },
  { id: 'b', amount: 50, status: 'failed', createdAt: 3 },
  { id: 'c', amount: 25, status: 'succeeded', createdAt: 2 },
  { id: 'd', amount: 10, status: 'pending', createdAt: 0 },
  { id: 'e', amount: 5, status: 'failed', createdAt: 1 },
] as const;

test('tổng tiền thành công', () => {
  // Sao chép sang mảng thường vì `as const` tạo mảng chỉ đọc
  const chargeList = [...charges];

  const summary = summarize(chargeList);

  expect(summary.succeededTotal).toBe(125);
});

test('số charge thất bại', () => {
  const chargeList = [...charges];

  const summary = summarize(chargeList);

  expect(summary.failedCount).toBe(2);
});

test('charge mới nhất', () => {
  const chargeList = [...charges];

  const summary = summarize(chargeList);

  expect(summary.latestId).toBe('b');
});

test('mảng rỗng', () => {
  // Danh sách không có charge nào
  const emptyList: Charge[] = [];

  const summary = summarize(emptyList);

  expect(summary).toEqual({ succeededTotal: 0, failedCount: 0, latestId: null });
});
