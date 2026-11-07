import { expect, test } from 'vitest';
import { applyOutcome, newTopup } from './ex05-topup-state.js';

// Mốc thời gian cố định để test không phụ thuộc đồng hồ thật
const t0 = new Date('2026-01-01T00:00:00.000Z');

// plus(n): thời điểm sau t0 đúng n giây
function plus(seconds: number) {
  const t0Ms = t0.getTime();
  const plusMs = t0Ms + seconds * 1000;
  const result = new Date(plusMs);
  return result;
}

// Các bậc chờ (giây) giữa các lần thử lại
const delays = [1, 5, 30];

test('created -> PENDING', () => {
  const topup = newTopup('t1', 100, t0);
  const outcome = { outcome: 'created', chargeId: 'ch_1' } as const;

  const next = applyOutcome(topup, outcome, t0, delays);

  // toMatchObject: chỉ cần chứa các trường này, không cần khớp toàn bộ đối tượng
  expect(next).toMatchObject({ status: 'PENDING', chargeId: 'ch_1', nextAttemptAt: null, attempts: 0 });
});

test('rejected -> FAILED', () => {
  const topup = newTopup('t1', 100, t0);
  const outcome = { outcome: 'rejected', status: 422 } as const;

  const next = applyOutcome(topup, outcome, t0, delays);

  expect(next).toMatchObject({ status: 'FAILED', failureCode: 'PAYMENT_REJECTED', nextAttemptAt: null });
});

test('unavailable: hẹn thử lại theo từng bậc rồi FAILED', () => {
  let topup = newTopup('t1', 100, t0);
  const unavailable = { outcome: 'unavailable' } as const;

  // Lần 1: chờ 1 giây
  topup = applyOutcome(topup, unavailable, t0, delays);
  expect(topup).toMatchObject({ status: 'REQUESTED', attempts: 1, nextAttemptAt: plus(1) });

  // Lần 2 (xảy ra lúc t0+1): chờ thêm 5 giây
  const timeOfSecondCall = plus(1);
  topup = applyOutcome(topup, unavailable, timeOfSecondCall, delays);
  expect(topup).toMatchObject({ status: 'REQUESTED', attempts: 2, nextAttemptAt: plus(1 + 5) });

  // Lần 3 (lúc t0+6): chờ thêm 30 giây
  const timeOfThirdCall = plus(6);
  topup = applyOutcome(topup, unavailable, timeOfThirdCall, delays);
  expect(topup).toMatchObject({ status: 'REQUESTED', attempts: 3, nextAttemptAt: plus(6 + 30) });

  // Lần 4 (lúc t0+36): hết bậc chờ -> FAILED
  const timeOfFourthCall = plus(36);
  topup = applyOutcome(topup, unavailable, timeOfFourthCall, delays);
  expect(topup).toMatchObject({ status: 'FAILED', attempts: 3, failureCode: 'PAYMENT_UNAVAILABLE', nextAttemptAt: null });
});

test('không sửa đối tượng cũ', () => {
  const original = newTopup('t1', 100, t0);
  const outcome = { outcome: 'unavailable' } as const;

  // Kết quả trả về không được dùng: test chỉ quan tâm đối tượng gốc có bị sửa không
  applyOutcome(original, outcome, t0, delays);

  // Đối tượng gốc vẫn giữ nguyên
  expect(original.attempts).toBe(0);
  expect(original.status).toBe('REQUESTED');
});
