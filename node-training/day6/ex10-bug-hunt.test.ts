import { expect, test } from 'vitest';
import { summarize } from './ex10-bug-hunt.js';

const charges = [
  { id: 'a', amount: 100, status: 'succeeded', createdAt: 1 },
  { id: 'b', amount: 50, status: 'failed', createdAt: 3 },
  { id: 'c', amount: 25, status: 'succeeded', createdAt: 2 },
  { id: 'd', amount: 10, status: 'pending', createdAt: 0 },
  { id: 'e', amount: 5, status: 'failed', createdAt: 1 },
] as const;

test('tổng tiền thành công', () => {
  expect(summarize([...charges]).succeededTotal).toBe(125);
});

test('số charge thất bại', () => {
  expect(summarize([...charges]).failedCount).toBe(2);
});

test('charge mới nhất', () => {
  expect(summarize([...charges]).latestId).toBe('b');
});

test('mảng rỗng', () => {
  expect(summarize([])).toEqual({ succeededTotal: 0, failedCount: 0, latestId: null });
});
