import { expect, test } from 'vitest';
import { withRetry } from './ex03-retry.js';

// Tạo một task "chập chờn": lỗi failTimes lần đầu rồi mới thành công.
// state.calls đếm số lần task đã bị gọi
function flaky(failTimes: number) {
  const state = { calls: 0 };
  async function task() {
    state.calls = state.calls + 1;
    if (state.calls <= failTimes) {
      throw new Error(`fail ${state.calls}`);
    }
    return `ok sau ${state.calls} lần gọi`;
  }
  return { state, task };
}

// Tạo hàm sleep giả: không chờ thật, chỉ ghi lại thời gian được yêu cầu chờ
function fakeSleep(slept: number[]) {
  return async function (ms: number) {
    slept.push(ms);
  };
}

test('thành công ngay: không chờ', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(0);
  expect(await withRetry(task, [1, 5, 30], fakeSleep(slept))).toBe('ok sau 1 lần gọi');
  expect(state.calls).toBe(1);
  expect(slept).toEqual([]);
});

test('hỏng 2 lần rồi thành công: chờ theo bậc', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(2);
  expect(await withRetry(task, [1, 5, 30], fakeSleep(slept))).toBe('ok sau 3 lần gọi');
  expect(state.calls).toBe(3);
  // Chờ 1 rồi 5 (chưa cần đến bậc 30)
  expect(slept).toEqual([1, 5]);
});

test('hỏng hết: ném lỗi cuối, tổng 4 lần gọi', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(99);
  await expect(withRetry(task, [1, 5, 30], fakeSleep(slept))).rejects.toThrow('fail 4');
  expect(state.calls).toBe(4); // 1 lần đầu + 3 lần thử lại
  expect(slept).toEqual([1, 5, 30]);
});

test('không có bậc chờ: chỉ gọi một lần', async () => {
  const { task, state } = flaky(99);
  await expect(withRetry(task, [], async () => {})).rejects.toThrow('fail 1');
  expect(state.calls).toBe(1);
});
