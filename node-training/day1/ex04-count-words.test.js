import { expect, test } from 'vitest';
import { countWords } from './ex04-count-words.js';

test('câu bình thường', () => {
  expect(countWords('xin chào Node')).toBe(3);
});

test('nhiều dấu cách liền nhau', () => {
  expect(countWords('xin chào  Node')).toBe(3);
  expect(countWords('  một  ')).toBe(1);
});

test('chuỗi rỗng', () => {
  expect(countWords('')).toBe(0);
  expect(countWords('   ')).toBe(0);
});
