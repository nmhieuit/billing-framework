import { expect, test } from 'vitest';
import { withRetry } from './ex03-retry.js';

function flaky(failTimes: number) {
  const state = { calls: 0 };
  const task = async () => {
    state.calls += 1;
    if (state.calls <= failTimes) throw new Error(`fail ${state.calls}`);
    return `ok sau ${state.calls} lần gọi`;
  };
  return { state, task };
}

test('thành công ngay: không chờ', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(0);
  expect(await withRetry(task, [1, 5, 30], async (ms) => void slept.push(ms))).toBe('ok sau 1 lần gọi');
  expect(state.calls).toBe(1);
  expect(slept).toEqual([]);
});

test('hỏng 2 lần rồi thành công: chờ theo bậc', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(2);
  expect(await withRetry(task, [1, 5, 30], async (ms) => void slept.push(ms))).toBe('ok sau 3 lần gọi');
  expect(state.calls).toBe(3);
  expect(slept).toEqual([1, 5]);
});

test('hỏng hết: ném lỗi cuối, tổng 4 lần gọi', async () => {
  const slept: number[] = [];
  const { task, state } = flaky(99);
  await expect(withRetry(task, [1, 5, 30], async (ms) => void slept.push(ms))).rejects.toThrow('fail 4');
  expect(state.calls).toBe(4);
  expect(slept).toEqual([1, 5, 30]);
});

test('không có bậc chờ: chỉ gọi một lần', async () => {
  const { task, state } = flaky(99);
  await expect(withRetry(task, [], async () => {})).rejects.toThrow('fail 1');
  expect(state.calls).toBe(1);
});
