import { expect, test } from 'vitest';
import { sum } from './e-sum.js';

test('cộng các số', () => {
  expect(sum([1, 2, 3])).toBe(6);
});

test('mảng rỗng', () => {
  expect(sum([])).toBe(0);
});
