import { expect, test } from 'vitest';
import { isEven } from './ex02-is-even.js';

test('số chẵn', () => {
  expect(isEven(4)).toBe(true);
  // 0 cũng là số chẵn (0 chia 2 dư 0)
  expect(isEven(0)).toBe(true);
});

test('số lẻ', () => {
  expect(isEven(7)).toBe(false);
  expect(isEven(1)).toBe(false);
});
