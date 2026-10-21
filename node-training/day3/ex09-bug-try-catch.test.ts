import { expect, test } from 'vitest';
import { loadOrDefault } from './ex09-bug-try-catch.js';

test('load thành công', async () => {
  expect(await loadOrDefault(async () => 7, 0)).toBe(7);
});

test('load thất bại -> dùng giá trị mặc định', async () => {
  const failing = async (): Promise<number> => {
    throw new Error('network down');
  };
  expect(await loadOrDefault(failing, -1)).toBe(-1);
});
