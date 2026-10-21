import { expect, test } from 'vitest';
import { addAmounts } from './ex08-bug-add-amounts.js';

test('cộng hai chuỗi số thành số', () => {
  expect(addAmounts('10', '5')).toBe(15);
});

test('vẫn chạy đúng với số thật', () => {
  expect(addAmounts(1, 2)).toBe(3);
});

test('từ chối giá trị không phải số', () => {
  expect(() => addAmounts('abc', '5')).toThrow('invalid amount: abc');
});
