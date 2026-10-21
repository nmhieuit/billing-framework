import { expect, test } from 'vitest';
import { findWalletOwner } from './ex09-bug-key-type.js';

test('tìm theo id dạng chuỗi', () => {
  expect(findWalletOwner('1')).toBe('An');
  expect(findWalletOwner('2')).toBe('Bình');
});

test('id không có', () => {
  expect(findWalletOwner('3')).toBeUndefined();
  expect(findWalletOwner('abc')).toBeUndefined();
});
