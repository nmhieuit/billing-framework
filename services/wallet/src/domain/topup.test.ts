import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { CustomerId } from './customer-id.js';
import { InvalidTopupError, StateTransitionError } from './errors.js';
import { MAX_TOPUP_AMOUNT, Topup } from './topup.js';

const t0 = new Date('2026-10-10T10:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

const requested = () =>
  Topup.request({
    id: 'tp_1',
    customerId: CustomerId.parse('c1'),
    accountId: 'wallet:c1',
    amount: Money.of(1500, 'VND'),
    now: t0,
  });

describe('Topup.request', () => {
  it('starts REQUESTED and due immediately', () => {
    expect(requested().toProps()).toMatchObject({
      id: 'tp_1',
      customerId: 'c1',
      accountId: 'wallet:c1',
      status: 'REQUESTED',
      chargeId: null,
      failureCode: null,
      attempts: 0,
      nextAttemptAt: t0,
      createdAt: t0,
      completedAt: null,
    });
    expect(requested().isDue(t0)).toBe(true);
    expect(requested().isDue(new Date(t0.getTime() - 1))).toBe(false);
  });

  it.each([0, -1])('rejects a non-positive amount (%d)', (amount) => {
    expect(() =>
      Topup.request({
        id: 'tp_x',
        customerId: CustomerId.parse('c1'),
        accountId: 'wallet:c1',
        amount: Money.of(amount, 'VND'),
        now: t0,
      }),
    ).toThrow(InvalidTopupError);
  });

  it('accepts exactly MAX_TOPUP_AMOUNT and rejects one more', () => {
    const request = (amount: number) =>
      Topup.request({
        id: 'tp_max',
        customerId: CustomerId.parse('c1'),
        accountId: 'wallet:c1',
        amount: Money.of(amount, 'VND'),
        now: t0,
      });
    expect(MAX_TOPUP_AMOUNT).toBe(1_000_000_000_000);
    expect(request(MAX_TOPUP_AMOUNT).toProps().amount.amount).toBe(MAX_TOPUP_AMOUNT);
    expect(() => request(MAX_TOPUP_AMOUNT + 1)).toThrow(InvalidTopupError);
  });
});

describe('Topup submission lifecycle', () => {
  it('claim() pushes the next attempt out by the lease without counting an attempt', () => {
    const claimed = requested().claim(t0, 60);
    expect(claimed.toProps()).toMatchObject({ status: 'REQUESTED', attempts: 0 });
    expect(claimed.toProps().nextAttemptAt).toEqual(plus(60));
    expect(claimed.isDue(plus(59))).toBe(false);
    expect(claimed.isDue(plus(60))).toBe(true);
  });

  it('recordSubmitted() moves to PENDING with the charge id', () => {
    const pending = requested().recordSubmitted('ch_1');
    expect(pending.toProps()).toMatchObject({
      status: 'PENDING',
      chargeId: 'ch_1',
      attempts: 1,
      nextAttemptAt: null,
      completedAt: null,
    });
    expect(pending.isDue(plus(1000))).toBe(false);
  });

  it('recordRejected() fails immediately with PAYMENT_REJECTED', () => {
    expect(requested().recordRejected(plus(1)).toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PAYMENT_REJECTED',
      attempts: 1,
      nextAttemptAt: null,
      completedAt: plus(1),
    });
  });

  it('recordUnavailable() follows the backoff and then gives up with PAYMENT_UNAVAILABLE', () => {
    const backoff = [1, 5];
    const first = requested().recordUnavailable(plus(10), backoff);
    expect(first.toProps()).toMatchObject({ status: 'REQUESTED', attempts: 1 });
    expect(first.toProps().nextAttemptAt).toEqual(plus(11));

    const second = first.recordUnavailable(plus(20), backoff);
    expect(second.toProps()).toMatchObject({ status: 'REQUESTED', attempts: 2 });
    expect(second.toProps().nextAttemptAt).toEqual(plus(25));

    const third = second.recordUnavailable(plus(30), backoff);
    expect(third.toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PAYMENT_UNAVAILABLE',
      attempts: 3,
      nextAttemptAt: null,
      completedAt: plus(30),
    });
  });

  it('gives up at once when the backoff list is empty', () => {
    expect(requested().recordUnavailable(t0, []).toProps().status).toBe('FAILED');
  });

  it.each(['claim', 'recordSubmitted', 'recordRejected', 'recordUnavailable'] as const)(
    '%s() is rejected unless the topup is REQUESTED',
    (method) => {
      const pending = requested().recordSubmitted('ch_1');
      const call = () => {
        if (method === 'claim') pending.claim(t0, 60);
        else if (method === 'recordSubmitted') pending.recordSubmitted('ch_2');
        else if (method === 'recordRejected') pending.recordRejected(t0);
        else pending.recordUnavailable(t0, [1]);
      };
      expect(call).toThrow(StateTransitionError);
    },
  );
});

describe('Topup result application', () => {
  it('applySucceeded() completes a REQUESTED, a PENDING or a late FAILED(PAYMENT_UNAVAILABLE) topup', () => {
    const done = (topup: Topup) => topup.applySucceeded('ch_9', plus(5)).toProps();
    for (const topup of [
      requested(),
      requested().recordSubmitted('ch_1'),
      requested().recordUnavailable(t0, []),
    ]) {
      expect(done(topup)).toMatchObject({
        status: 'SUCCEEDED',
        chargeId: 'ch_9',
        nextAttemptAt: null,
        completedAt: plus(5),
      });
    }
  });

  it('applySucceeded() refuses a FAILED topup that failed for another reason, and a SUCCEEDED one', () => {
    expect(() => requested().recordRejected(t0).applySucceeded('ch_1', t0)).toThrow(
      StateTransitionError,
    );
    const failed = requested().applyFailed('card_declined', 'ch_1', t0);
    expect(() => failed.applySucceeded('ch_1', t0)).toThrow(StateTransitionError);
    const succeeded = requested().applySucceeded('ch_1', t0);
    expect(() => succeeded.applySucceeded('ch_1', t0)).toThrow(StateTransitionError);
  });

  it('applyFailed() fails a REQUESTED or PENDING topup with the gateway failure code', () => {
    for (const topup of [requested(), requested().recordSubmitted('ch_1')]) {
      expect(topup.applyFailed('card_declined', 'ch_1', plus(5)).toProps()).toMatchObject({
        status: 'FAILED',
        failureCode: 'card_declined',
        chargeId: 'ch_1',
        nextAttemptAt: null,
        completedAt: plus(5),
      });
    }
  });

  it('applyFailed() never overrides a SUCCEEDED or FAILED topup', () => {
    expect(() => requested().applySucceeded('ch_1', t0).applyFailed('x_y', 'ch_1', t0)).toThrow(
      StateTransitionError,
    );
    expect(() => requested().recordRejected(t0).applyFailed('x_y', 'ch_1', t0)).toThrow(
      StateTransitionError,
    );
  });
});
