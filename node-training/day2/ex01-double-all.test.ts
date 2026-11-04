import { expect, test } from 'vitest';
import { doubleAll } from './ex01-double-all.js';

test('nhân đôi từng phần tử', () => {
  expect(doubleAll([1, 2, 3])).toEqual([2, 4, 6]);
  expect(doubleAll([])).toEqual([]);
});

test('không làm thay đổi mảng gốc', () => {
  const input = [5, 6];
  doubleAll(input);
  // Sau khi gọi hàm, mảng gốc vẫn giữ nguyên
  expect(input).toEqual([5, 6]);
});
