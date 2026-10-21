import { expect, test } from 'vitest';
import { applyDiscount } from './ex08-discount.js';

test('giảm 10%', () => {
  expect(applyDiscount(1000, 10)).toBe(900);
});

test('giảm 0% giữ nguyên giá', () => {
  expect(applyDiscount(1000, 0)).toBe(1000);
});

test('giảm 100% còn 0', () => {
  expect(applyDiscount(1000, 100)).toBe(0);
});

test('làm tròn lên khi có số lẻ', () => {
  expect(applyDiscount(999, 50)).toBe(500);
});

test('percent âm bị từ chối', () => {
  expect(() => applyDiscount(1000, -1)).toThrow('percent must be between 0 and 100');
});

test('percent lớn hơn 100 bị từ chối', () => {
  expect(() => applyDiscount(1000, 101)).toThrow('percent must be between 0 and 100');
});
