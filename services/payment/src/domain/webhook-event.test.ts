import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Charge } from './charge.js';
import { StateTransitionError } from './errors.js';
import { DEFAULT_SCENARIO, parseScenario } from './scenario.js';
import { WebhookEvent } from './webhook-event.js';

const t0 = new Date('2026-10-09T10:00:00.000Z');
const plus = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

function completedCharge(simulate?: string) {
  const scenario = simulate ? parseScenario(simulate) : DEFAULT_SCENARIO;
  return Charge.create({
    id: 'ch_1',
    reference: 'topup-1',
    amount: Money.of(150000, 'VND'),
    scenario,
    now: t0,
  }).complete(t0);
}

describe('WebhookEvent.forCharge', () => {
  it('builds a charge.succeeded payload', () => {
    const event = WebhookEvent.forCharge(completedCharge(), 'evt_1', t0);
    const props = event.toProps();
    expect(props).toMatchObject({
      eventId: 'evt_1',
      chargeId: 'ch_1',
      type: 'charge.succeeded',
      status: 'PENDING',
      attempts: 0,
      sendTwice: false,
      deliveredAt: null,
    });
    expect(props.nextAttemptAt).toEqual(t0);
    expect(JSON.parse(props.payload)).toEqual({
      eventId: 'evt_1',
      type: 'charge.succeeded',
      createdAt: '2026-10-09T10:00:00.000Z',
      data: {
        chargeId: 'ch_1',
        reference: 'topup-1',
        amount: 150000,
        currency: 'VND',
        status: 'SUCCEEDED',
        completedAt: '2026-10-09T10:00:00.000Z',
      },
    });
  });

  it('builds a charge.failed payload with the failure code', () => {
    const event = WebhookEvent.forCharge(completedCharge('fail=card_declined'), 'evt_2', t0);
    expect(event.toProps().type).toBe('charge.failed');
    expect(JSON.parse(event.toProps().payload).data).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
    });
  });

  it('marks the event to be sent twice for webhook=duplicate', () => {
    const event = WebhookEvent.forCharge(completedCharge('webhook=duplicate'), 'evt_3', t0);
    expect(event.toProps().sendTwice).toBe(true);
  });

  it('refuses a charge that is not completed', () => {
    const pending = Charge.create({
      id: 'ch_9',
      reference: 'r',
      amount: Money.of(1, 'VND'),
      scenario: DEFAULT_SCENARIO,
      now: t0,
    });
    expect(() => WebhookEvent.forCharge(pending, 'evt_9', t0)).toThrow(StateTransitionError);
  });
});

describe('WebhookEvent lifecycle', () => {
  const fresh = () => WebhookEvent.forCharge(completedCharge(), 'evt_1', t0);

  it('is due at its nextAttemptAt', () => {
    expect(fresh().isDue(t0)).toBe(true);
    expect(fresh().isDue(new Date(t0.getTime() - 1))).toBe(false);
  });

  it('claim() pushes the next attempt out by the lease without counting an attempt', () => {
    const claimed = fresh().claim(t0, 60);
    expect(claimed.toProps()).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(claimed.toProps().nextAttemptAt).toEqual(plus(t0, 60));
    expect(claimed.isDue(plus(t0, 59))).toBe(false);
    expect(claimed.isDue(plus(t0, 60))).toBe(true);
  });

  it('recordSuccess() delivers the event', () => {
    const done = fresh().recordSuccess(plus(t0, 1));
    expect(done.toProps()).toMatchObject({
      status: 'DELIVERED',
      attempts: 1,
      nextAttemptAt: null,
      deliveredAt: plus(t0, 1),
    });
  });

  it('recordFailure() follows the backoff, then gives up (1 first try + len(backoff) retries)', () => {
    const backoff = [1, 5];
    const first = fresh().recordFailure(plus(t0, 10), backoff);
    expect(first.toProps()).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(first.toProps().nextAttemptAt).toEqual(plus(t0, 11));

    const second = first.recordFailure(plus(t0, 20), backoff);
    expect(second.toProps()).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(second.toProps().nextAttemptAt).toEqual(plus(t0, 25));

    const third = second.recordFailure(plus(t0, 30), backoff);
    expect(third.toProps()).toMatchObject({ status: 'FAILED', attempts: 3, nextAttemptAt: null });
  });

  it('gives up right away when the backoff list is empty', () => {
    expect(fresh().recordFailure(t0, []).toProps().status).toBe('FAILED');
  });

  it.each(['claim', 'recordSuccess', 'recordFailure'] as const)(
    '%s() is rejected once the event is no longer PENDING',
    (method) => {
      const delivered = fresh().recordSuccess(t0);
      const call = () => {
        if (method === 'claim') delivered.claim(t0, 60);
        else if (method === 'recordSuccess') delivered.recordSuccess(t0);
        else delivered.recordFailure(t0, [1]);
      };
      expect(call).toThrow(StateTransitionError);
    },
  );
});
