import { expect, test } from 'vitest';
import { greet } from './ex01-greet.js';

test('chào một người', () => {
  expect(greet('An')).toBe('Xin chào, An!');
});

test('chào người khác', () => {
  expect(greet('Bình')).toBe('Xin chào, Bình!');
});
