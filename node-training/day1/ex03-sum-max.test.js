import { expect, test } from 'vitest';
import { max, sum } from './ex03-sum-max.js';

test('sum', () => {
  expect(sum([1, 2, 3])).toBe(6);
  expect(sum([])).toBe(0); // mảng rỗng
  expect(sum([-5, 5])).toBe(0); // có số âm
});

test('max', () => {
  expect(max([4, 9, 2])).toBe(9);
  expect(max([-3, -1, -7])).toBe(-1); // toàn số âm
  // toBeUndefined: kết quả phải là undefined
  expect(max([])).toBeUndefined();
});
