import { expect, test } from 'vitest';
import { type ChargeOutcome, submitWithRetry } from './ex04-submit-with-retry.js';

// Tạo hàm attempt giả: mỗi lần gọi trả về lần lượt từng phần tử của outcomes,
// hết danh sách thì cứ trả về phần tử cuối
function script(outcomes: ChargeOutcome[]) {
  // Số lần attempt giả đã bị gọi (closure: được giữ lại giữa các lần gọi)
  let i = 0;

  // Hàm attempt giả mà submitWithRetry sẽ gọi
  async function nextOutcome() {
    // Math.min giữ chỉ số không vượt quá phần tử cuối
    const index = Math.min(i, outcomes.length - 1);
    i = i + 1;
    const outcome = outcomes[index] as ChargeOutcome;
    return outcome;
  }
  return nextOutcome;
}

// Tạo hàm sleep giả: chỉ ghi lại thời gian được yêu cầu chờ
function fakeSleep(slept: number[]) {
  async function recordSleep(ms: number) {
    slept.push(ms);
  }
  return recordSleep;
}

test('created ngay lần đầu', async () => {
  const slept: number[] = [];
  const attempt = script([{ outcome: 'created', chargeId: 'c1' }]);
  const sleepFunction = fakeSleep(slept);

  const result = await submitWithRetry(attempt, [1, 5], sleepFunction);

  expect(result).toEqual({ outcome: 'created', chargeId: 'c1', attempts: 1 });
  expect(slept).toEqual([]);
});

test('unavailable rồi created: thử lại', async () => {
  const slept: number[] = [];
  const attempt = script([{ outcome: 'unavailable' }, { outcome: 'unavailable' }, { outcome: 'created', chargeId: 'c9' }]);
  const sleepFunction = fakeSleep(slept);

  const result = await submitWithRetry(attempt, [1, 5, 30], sleepFunction);

  expect(result).toEqual({ outcome: 'created', chargeId: 'c9', attempts: 3 });
  expect(slept).toEqual([1, 5]);
});

test('rejected: không thử lại', async () => {
  const slept: number[] = [];
  const attempt = script([{ outcome: 'rejected', status: 422 }]);
  const sleepFunction = fakeSleep(slept);

  const result = await submitWithRetry(attempt, [1, 5], sleepFunction);

  expect(result).toEqual({ outcome: 'rejected', status: 422, attempts: 1 });
  expect(slept).toEqual([]);
});

test('unavailable mãi: hết bậc thì bỏ cuộc', async () => {
  const slept: number[] = [];
  const attempt = script([{ outcome: 'unavailable' }]);
  const sleepFunction = fakeSleep(slept);

  const result = await submitWithRetry(attempt, [1, 5], sleepFunction);

  expect(result).toEqual({ outcome: 'unavailable', attempts: 3 });
  expect(slept).toEqual([1, 5]);
});
