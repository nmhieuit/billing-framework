import { expect, test } from 'vitest';
import { safeDivide } from './ex04-safe-divide.js';

test('chia được', async () => {
  expect(await safeDivide(10, 2)).toEqual({ ok: true, value: 5 });
});

test('chia cho 0 không ném lỗi', async () => {
  expect(await safeDivide(1, 0)).toEqual({ ok: false, error: 'division by zero' });
});
