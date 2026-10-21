import { expect, test } from 'vitest';
import { totalAmount } from './ex08-bug-foreach.js';

const amounts: Record<string, number> = { a: 10, b: 20, c: 30 };
const loadAmount = (id: string) => new Promise<number>((resolve) => setTimeout(() => resolve(amounts[id] ?? 0), 10));

test('cộng đủ các số tiền', async () => {
  expect(await totalAmount(['a', 'b', 'c'], loadAmount)).toBe(60);
});

test('danh sách rỗng', async () => {
  expect(await totalAmount([], loadAmount)).toBe(0);
});
