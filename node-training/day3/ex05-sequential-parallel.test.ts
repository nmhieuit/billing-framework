import { expect, test } from 'vitest';
import { runParallel, runSequential } from './ex05-sequential-parallel.js';

const makeTasks = () =>
  [1, 2, 3].map((n) => () => new Promise<number>((resolve) => setTimeout(() => resolve(n * 10), 100)));

test('lần lượt: đúng kết quả và mất ~300ms', async () => {
  const start = Date.now();
  expect(await runSequential(makeTasks())).toEqual([10, 20, 30]);
  expect(Date.now() - start).toBeGreaterThanOrEqual(290);
});

test('song song: đúng kết quả và mất ~100ms', async () => {
  const start = Date.now();
  expect(await runParallel(makeTasks())).toEqual([10, 20, 30]);
  expect(Date.now() - start).toBeLessThan(250);
});
