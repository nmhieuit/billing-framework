import { expect, test } from 'vitest';
import { sleep } from './ex02-sleep.js';

test('chờ đủ thời gian', async () => {
  const start = Date.now();
  await sleep(100);
  expect(Date.now() - start).toBeGreaterThanOrEqual(95);
});

test('trả về Promise', () => {
  expect(sleep(1)).toBeInstanceOf(Promise);
});
