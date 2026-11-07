import { expect, test } from 'vitest';
import { withRetry } from './ex03-retry.js';

// Tạo một task "chập chờn": lỗi failTimes lần đầu rồi mới thành công.
// state.calls đếm số lần task đã bị gọi
function flaky(failTimes: number) {
  const state = { calls: 0 };

  // Hàm task thật sự được withRetry gọi (closure: dùng được state và failTimes ở ngoài)
  async function task() {
    state.calls = state.calls + 1;

    // Nhánh còn trong số lần phải lỗi: ném lỗi kèm số lần gọi
    if (state.calls <= failTimes) {
      throw new Error(`fail ${state.calls}`);
    }

    // Nhánh hết lỗi: trả kết quả thành công
    return `ok sau ${state.calls} lần gọi`;
  }

  return { state, task };
}

// Tạo hàm sleep giả: không chờ thật, chỉ ghi lại thời gian được yêu cầu chờ
function fakeSleep(slept: number[]) {
  // Hàm sleep giả mà withRetry sẽ gọi (closure: dùng được mảng slept ở ngoài)
  async function recordSleep(ms: number) {
    slept.push(ms);
  }
  return recordSleep;
}

test('thành công ngay: không chờ', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(0);
  const sleepFunction = fakeSleep(slept);

  const result = await withRetry(task, [1, 5, 30], sleepFunction);

  expect(result).toBe('ok sau 1 lần gọi');
  expect(state.calls).toBe(1);
  expect(slept).toEqual([]);
});

test('hỏng 2 lần rồi thành công: chờ theo bậc', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(2);
  const sleepFunction = fakeSleep(slept);

  const result = await withRetry(task, [1, 5, 30], sleepFunction);

  expect(result).toBe('ok sau 3 lần gọi');
  expect(state.calls).toBe(3);
  // Chờ 1 rồi 5 (chưa cần đến bậc 30)
  expect(slept).toEqual([1, 5]);
});

test('hỏng hết: ném lỗi cuối, tổng 4 lần gọi', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(99);
  const sleepFunction = fakeSleep(slept);

  // Chưa await: lấy Promise để kiểm tra nó bị từ chối
  const retryPromise = withRetry(task, [1, 5, 30], sleepFunction);

  await expect(retryPromise).rejects.toThrow('fail 4');
  expect(state.calls).toBe(4); // 1 lần đầu + 3 lần thử lại
  expect(slept).toEqual([1, 5, 30]);
});

test('không có bậc chờ: chỉ gọi một lần', async () => {
  const { task, state } = flaky(99);

  // Hàm sleep không làm gì (sẽ không bao giờ được gọi vì không có bậc chờ)
  async function doNotSleep() {}

  const retryPromise = withRetry(task, [], doNotSleep);

  await expect(retryPromise).rejects.toThrow('fail 1');
  expect(state.calls).toBe(1);
});
