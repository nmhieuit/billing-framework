import { expect, test } from 'vitest';
import { runInBackground } from './ex07-fire-and-forget.js';

// Hàm chờ ms mili-giây (dùng trong test để đợi task nền chạy xong)
function sleep(ms: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

test('trả về ngay, không chờ task', async () => {
  let finished = false;
  const start = Date.now();

  // Task nền mất 100ms rồi đặt finished = true
  runInBackground(
    async () => {
      await sleep(100);
      finished = true;
    },
    () => {},
  );

  // Vừa gọi xong: hàm đã trả về ngay, task chưa kịp xong
  expect(Date.now() - start).toBeLessThan(50);
  expect(finished).toBe(false);

  // Chờ đủ lâu thì task nền đã xong
  await sleep(150);
  expect(finished).toBe(true);
});

test('lỗi bất đồng bộ được chuyển cho onError', async () => {
  const errors: unknown[] = [];

  runInBackground(
    async () => {
      await sleep(10);
      throw new Error('boom');
    },
    (error) => errors.push(error),
  );

  await sleep(50);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toBe('boom');
});

test('lỗi đồng bộ cũng chuyển cho onError, không ném ra ngoài', async () => {
  const errors: unknown[] = [];

  // not.toThrow: gọi hàm không được ném lỗi ra ngoài
  expect(() =>
    runInBackground(
      () => {
        throw new Error('sync boom');
      },
      (error) => errors.push(error),
    ),
  ).not.toThrow();

  await sleep(10);
  expect((errors[0] as Error).message).toBe('sync boom');
});
