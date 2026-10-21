import { expect, test } from 'vitest';
import { retryTimes } from './ex08-bug-retry-count.js';

test('retries = 2: gọi tối đa 3 lần', async () => {
  let calls = 0;
  await expect(
    retryTimes(async () => {
      calls += 1;
      throw new Error('hỏng');
    }, 2),
  ).rejects.toThrow('hỏng');
  expect(calls).toBe(3);
});

test('thành công ở lần thử lại cuối', async () => {
  let calls = 0;
  const result = await retryTimes(async () => {
    calls += 1;
    if (calls < 3) throw new Error('hỏng');
    return 'ok';
  }, 2);
  expect(result).toBe('ok');
});

test('retries = 0: chỉ gọi một lần', async () => {
  let calls = 0;
  await expect(
    retryTimes(async () => {
      calls += 1;
      throw new Error('hỏng');
    }, 0),
  ).rejects.toThrow('hỏng');
  expect(calls).toBe(1);
});
