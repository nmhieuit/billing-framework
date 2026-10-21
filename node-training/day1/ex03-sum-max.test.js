import { expect, test } from 'vitest';
import { max, sum } from './ex03-sum-max.js';

test('sum', () => {
  expect(sum([1, 2, 3])).toBe(6);
  expect(sum([])).toBe(0);
  expect(sum([-5, 5])).toBe(0);
});

test('max', () => {
  expect(max([4, 9, 2])).toBe(9);
  expect(max([-3, -1, -7])).toBe(-1);
  expect(max([])).toBeUndefined();
});
