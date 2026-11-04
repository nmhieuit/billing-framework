import { expect, test } from 'vitest';
import { applyDiscount } from './ex08-discount.js';

// Mỗi test kiểm tra một tình huống riêng của applyDiscount

test('giảm 10%', () => {
  expect(applyDiscount(1000, 10)).toBe(900);
});

test('giảm 0% giữ nguyên giá', () => {
  expect(applyDiscount(1000, 0)).toBe(1000);
});

test('giảm 100% còn 0', () => {
  expect(applyDiscount(1000, 100)).toBe(0);
});

test('làm tròn', () => {
  // 999 giảm 50% = 499.5, làm tròn lên thành 500
  expect(applyDiscount(999, 50)).toBe(500);
});

test('percent âm bị từ chối', () => {
  expect(() => applyDiscount(1000, -1)).toThrow();
});

test('percent > 100 bị từ chối', () => {
  expect(() => applyDiscount(1000, 101)).toThrow();
});
