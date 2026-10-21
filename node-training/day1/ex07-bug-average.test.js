import { expect, test } from 'vitest';
import { average } from './ex07-bug-average.js';

test('trung bình', () => {
  expect(average([2, 4, 6])).toBe(4);
  expect(average([10])).toBe(10);
});

test('mảng rỗng', () => {
  expect(average([])).toBe(0);
});
