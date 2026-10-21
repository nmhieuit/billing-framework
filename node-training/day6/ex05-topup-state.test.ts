import { expect, test } from 'vitest';
import { applyOutcome, newTopup } from './ex05-topup-state.js';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const delays = [1, 5, 30];

test('created -> PENDING', () => {
  const next = applyOutcome(newTopup('t1', 100, t0), { outcome: 'created', chargeId: 'ch_1' }, t0, delays);
  expect(next).toMatchObject({ status: 'PENDING', chargeId: 'ch_1', nextAttemptAt: null, attempts: 0 });
});

test('rejected -> FAILED', () => {
  const next = applyOutcome(newTopup('t1', 100, t0), { outcome: 'rejected', status: 422 }, t0, delays);
  expect(next).toMatchObject({ status: 'FAILED', failureCode: 'PAYMENT_REJECTED', nextAttemptAt: null });
});

test('unavailable: hẹn thử lại theo từng bậc rồi FAILED', () => {
  let topup = newTopup('t1', 100, t0);
  const unavailable = { outcome: 'unavailable' } as const;

  topup = applyOutcome(topup, unavailable, t0, delays);
  expect(topup).toMatchObject({ status: 'REQUESTED', attempts: 1, nextAttemptAt: plus(1) });

  topup = applyOutcome(topup, unavailable, plus(1), delays);
  expect(topup).toMatchObject({ status: 'REQUESTED', attempts: 2, nextAttemptAt: plus(1 + 5) });

  topup = applyOutcome(topup, unavailable, plus(6), delays);
  expect(topup).toMatchObject({ status: 'REQUESTED', attempts: 3, nextAttemptAt: plus(6 + 30) });

  topup = applyOutcome(topup, unavailable, plus(36), delays);
  expect(topup).toMatchObject({ status: 'FAILED', attempts: 4, failureCode: 'PAYMENT_UNAVAILABLE', nextAttemptAt: null });
});

test('không sửa đối tượng cũ', () => {
  const original = newTopup('t1', 100, t0);
  applyOutcome(original, { outcome: 'unavailable' }, t0, delays);
  expect(original.attempts).toBe(0);
  expect(original.status).toBe('REQUESTED');
});
