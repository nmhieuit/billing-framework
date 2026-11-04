import { expect, test } from 'vitest';
import { runParallel, runSequential } from './ex05-sequential-parallel.js';

// Tạo 3 task, mỗi task mất 100ms rồi trả về 10, 20, 30
function makeTasks() {
  return [1, 2, 3].map(function (n) {
    return function () {
      return new Promise<number>(function (resolve) {
        setTimeout(function () {
          resolve(n * 10);
        }, 100);
      });
    };
  });
}

test('lần lượt: đúng kết quả và mất ~300ms', async () => {
  const start = Date.now();
  expect(await runSequential(makeTasks())).toEqual([10, 20, 30]);
  // 3 task x 100ms = 300ms
  expect(Date.now() - start).toBeGreaterThanOrEqual(290);
});

test('song song: đúng kết quả và mất ~100ms', async () => {
  const start = Date.now();
  expect(await runParallel(makeTasks())).toEqual([10, 20, 30]);
  // Chạy cùng lúc nên chỉ mất khoảng 100ms
  expect(Date.now() - start).toBeLessThan(250);
});
