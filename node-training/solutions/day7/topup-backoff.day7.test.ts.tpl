import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { CustomerId } from './customer-id.js';
import { StateTransitionError } from './errors.js';
import { Topup } from './topup.js';

const DEFAULT_BACKOFF = [1, 5, 30, 120, 600];
const t0 = new Date('2026-10-10T10:00:00.000Z');
const seconds = (n: number) => new Date(t0.getTime() + n * 1000);

const requested = () =>
  Topup.request({
    id: 'tp_1',
    customerId: CustomerId.parse('c1'),
    accountId: 'wallet:c1',
    amount: Money.of(1500, 'VND'),
    now: t0,
  });

describe('Topup.recordUnavailable với backoff mặc định', () => {
  it('hẹn lại đúng 1, 5, 30, 120, 600 giây sau mỗi lần thất bại', () => {
    let topup = requested();
    let now = t0;
    DEFAULT_BACKOFF.forEach((delay, index) => {
      topup = topup.recordUnavailable(now, DEFAULT_BACKOFF);
      expect(topup.toProps()).toMatchObject({ status: 'REQUESTED', attempts: index + 1 });
      expect(topup.toProps().nextAttemptAt).toEqual(new Date(now.getTime() + delay * 1000));
      now = topup.toProps().nextAttemptAt as Date;
    });
    expect(now).toEqual(seconds(1 + 5 + 30 + 120 + 600));
  });

  it('lần thất bại thứ 6 là FAILED với PAYMENT_UNAVAILABLE', () => {
    let topup = requested();
    for (let i = 0; i < DEFAULT_BACKOFF.length; i += 1) {
      topup = topup.recordUnavailable(t0, DEFAULT_BACKOFF);
    }
    const failed = topup.recordUnavailable(seconds(756), DEFAULT_BACKOFF);
    expect(failed.toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PAYMENT_UNAVAILABLE',
      attempts: 6,
      nextAttemptAt: null,
      completedAt: seconds(756),
    });
  });

  it('một lần thành công giữa chừng chặn mọi lần thất bại sau đó', () => {
    const pending = requested()
      .recordUnavailable(t0, DEFAULT_BACKOFF)
      .recordUnavailable(seconds(1), DEFAULT_BACKOFF)
      .recordSubmitted('ch_1');
    expect(pending.toProps().status).toBe('PENDING');
    expect(() => pending.recordUnavailable(seconds(10), DEFAULT_BACKOFF)).toThrow(StateTransitionError);
  });
});
