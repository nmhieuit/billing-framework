import { expect, test } from 'vitest';
import { type ChargeOutcome, submitWithRetry } from './ex04-submit-with-retry.js';

// Tạo hàm attempt giả: mỗi lần gọi trả về lần lượt từng phần tử của outcomes,
// hết danh sách thì cứ trả về phần tử cuối
function script(outcomes: ChargeOutcome[]) {
  let i = 0;
  return async function () {
    const index = Math.min(i, outcomes.length - 1);
    i = i + 1;
    return outcomes[index] as ChargeOutcome;
  };
}

// Tạo hàm sleep giả: chỉ ghi lại thời gian được yêu cầu chờ
function fakeSleep(slept: number[]) {
  return async function (ms: number) {
    slept.push(ms);
  };
}

test('created ngay lần đầu', async () => {
  const slept: number[] = [];
  const result = await submitWithRetry(script([{ outcome: 'created', chargeId: 'c1' }]), [1, 5], fakeSleep(slept));
  expect(result).toEqual({ outcome: 'created', chargeId: 'c1', attempts: 1 });
  expect(slept).toEqual([]);
});

test('unavailable rồi created: thử lại', async () => {
  const slept: number[] = [];
  const result = await submitWithRetry(
    script([{ outcome: 'unavailable' }, { outcome: 'unavailable' }, { outcome: 'created', chargeId: 'c9' }]),
    [1, 5, 30],
    fakeSleep(slept),
  );
  expect(result).toEqual({ outcome: 'created', chargeId: 'c9', attempts: 3 });
  expect(slept).toEqual([1, 5]);
});

test('rejected: không thử lại', async () => {
  const slept: number[] = [];
  const result = await submitWithRetry(script([{ outcome: 'rejected', status: 422 }]), [1, 5], fakeSleep(slept));
  expect(result).toEqual({ outcome: 'rejected', status: 422, attempts: 1 });
  expect(slept).toEqual([]);
});

test('unavailable mãi: hết bậc thì bỏ cuộc', async () => {
  const slept: number[] = [];
  const result = await submitWithRetry(script([{ outcome: 'unavailable' }]), [1, 5], fakeSleep(slept));
  expect(result).toEqual({ outcome: 'unavailable', attempts: 3 });
  expect(slept).toEqual([1, 5]);
});
